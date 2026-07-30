locals {
  name_prefix = "${var.project}-${var.environment}"
  has_image   = var.app_image != ""
  has_secret  = var.session_secret_ssm_arn != ""
}

# ---------------------------------------------------------------------------
# DynamoDB — single table, on-demand billing (see server/db/keys.js for the
# PK/SK scheme this app assumes; matches what create-dynamodb-table.js
# creates locally, so the app behaves identically against either).
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "app" {
  name         = "${local.name_prefix}-app"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }
}

# ---------------------------------------------------------------------------
# ECR — one repo for the one image this app builds.
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name                 = "${local.name_prefix}/app"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# IAM — one role for App Runner to pull the image, one role for the running
# app to call DynamoDB (scoped to just this table).
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "apprunner_build_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_access" {
  name               = "${local.name_prefix}-apprunner-access-role"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_assume.json
}

resource "aws_iam_role_policy_attachment" "apprunner_access_ecr" {
  role       = aws_iam_role.apprunner_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

data "aws_iam_policy_document" "apprunner_instance_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_instance" {
  name               = "${local.name_prefix}-apprunner-instance-role"
  assume_role_policy = data.aws_iam_policy_document.apprunner_instance_assume.json
}

data "aws_iam_policy_document" "app_dynamodb" {
  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:TransactGetItems",
      "dynamodb:TransactWriteItems",
    ]
    resources = [aws_dynamodb_table.app.arn]
  }
}

resource "aws_iam_policy" "app_dynamodb" {
  name   = "${local.name_prefix}-app-dynamodb"
  policy = data.aws_iam_policy_document.app_dynamodb.json
}

resource "aws_iam_role_policy_attachment" "apprunner_instance_dynamodb" {
  role       = aws_iam_role.apprunner_instance.name
  policy_arn = aws_iam_policy.app_dynamodb.arn
}

# SESSION_SECRET stays stored in SSM (rotate with `make ssm-put-secret`),
# but Terraform reads its value at apply time and injects it as a plain
# runtime_environment_variable, rather than using App Runner's own
# runtime_environment_secrets fetch. That path — instance role holding
# ssm:GetParameter, referenced by ARN in runtime_environment_secrets, which
# is how AWS's own docs say to do this — reliably produced a CREATE_FAILED
# with zero application logs (the container never even started), for
# reasons App Runner's console/CloudWatch never surfaced. Confirmed via a
# controlled test: identical service, only this one field changed from
# runtime_environment_secrets to a plain variable, and creation succeeded
# immediately. Tradeoff: the secret value is visible in `aws apprunner
# describe-service` / terraform state to anyone with read access to this
# AWS account — acceptable here since it's a session-signing key for an
# 8-person hobby app, not a credential with its own blast radius.
data "aws_ssm_parameter" "session_secret" {
  count           = local.has_secret ? 1 : 0
  name            = var.session_secret_ssm_arn
  with_decryption = true
}

# ---------------------------------------------------------------------------
# App Runner — no VPC, no ALB, no NAT: App Runner is a fully managed
# container host with its own HTTPS endpoint out of the box, and DynamoDB
# is a public AWS API reachable without any networking setup. Deliberately
# the lightest way to run one small container with a stable URL.
#
# Only created once there's an image to point at AND the session secret
# exists in SSM — on a from-scratch `terraform apply`, that's not true yet
# (see variables.tf), so the first apply creates just ECR/DynamoDB/IAM;
# build+push an image and run `make ssm-put-secret`, then re-apply with
# `-var app_image=...` to bring the service up.
# ---------------------------------------------------------------------------
resource "aws_apprunner_service" "app" {
  count        = local.has_image && local.has_secret ? 1 : 0
  service_name = "${local.name_prefix}-app"

  source_configuration {
    auto_deployments_enabled = false # deploys are explicit — see `make deploy`

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }

    image_repository {
      image_identifier      = var.app_image
      image_repository_type = "ECR"

      image_configuration {
        port = "4173"
        runtime_environment_variables = {
          AWS_REGION     = var.aws_region
          DYNAMODB_TABLE = aws_dynamodb_table.app.name
          PORT           = "4173"
          NODE_ENV       = "production"
          SESSION_SECRET = data.aws_ssm_parameter.session_secret[0].value
          # DYNAMODB_ENDPOINT intentionally omitted — unset means the app
          # talks to real AWS DynamoDB (see server/db/client.js).
        }
      }
    }
  }

  instance_configuration {
    cpu               = "256" # 0.25 vCPU — smallest tier, plenty for ~9 users
    memory            = "512" # 0.5 GB
    instance_role_arn = aws_iam_role.apprunner_instance.arn
  }

  health_check_configuration {
    protocol = "HTTP"
    path     = "/"
    interval = 10
    timeout  = 5
  }

  depends_on = [aws_iam_role_policy_attachment.apprunner_access_ecr]
}

# ---------------------------------------------------------------------------
# Custom domain — calore1.com, registered via Route 53 (already creates the
# hosted zone automatically). App Runner issues/renews the ACM certificate
# itself once the validation records below exist; no separate ACM resource
# needed. Gated on the same has_image/has_secret condition as the service
# itself, since there's nothing to attach a domain to before then.
# ---------------------------------------------------------------------------
data "aws_route53_zone" "app" {
  count        = local.has_image && local.has_secret ? 1 : 0
  name         = "calore1.com"
  private_zone = false
}

resource "aws_apprunner_custom_domain_association" "app" {
  count       = local.has_image && local.has_secret ? 1 : 0
  domain_name = "calore1.com"
  service_arn = aws_apprunner_service.app[0].arn
}

locals {
  # App Runner's own Route 53 hosted zone ID, used as the Alias target below
  # — NOT the zone_id of our calore1.com hosted zone. Fixed per-region value
  # from AWS's published endpoints table (docs.aws.amazon.com/general/latest/gr/apprunner.html);
  # this one is us-east-1 only, matching var.aws_region's default/only value.
  apprunner_route53_zone_id = "Z01915732ZBZKC8D32TPT"

  # App Runner returns one certificate validation CNAME per domain name it's
  # validating (apex + www, since enable_www_subdomain defaults to true on
  # the association above) — keyed by record name so for_each doesn't
  # assume a fixed count.
  cert_validation_records = local.has_image && local.has_secret ? {
    for r in aws_apprunner_custom_domain_association.app[0].certificate_validation_records : r.name => r
  } : {}
}

resource "aws_route53_record" "app_cert_validation" {
  for_each = local.cert_validation_records
  zone_id  = data.aws_route53_zone.app[0].zone_id
  name     = each.value.name
  type     = each.value.type
  ttl      = 300
  records  = [each.value.value]
}

# Apex domains can't use CNAME per the DNS spec — Route 53's Alias record
# type is the standard workaround, and App Runner has supported it as an
# alias target since Aug 2022. www gets the same treatment for consistency
# (a plain CNAME would also work for www, but alias records have no extra
# Route 53 cost and no TTL to manage).
resource "aws_route53_record" "app_apex" {
  count   = local.has_image && local.has_secret ? 1 : 0
  zone_id = data.aws_route53_zone.app[0].zone_id
  name    = "calore1.com"
  type    = "A"
  alias {
    name                   = aws_apprunner_custom_domain_association.app[0].dns_target
    zone_id                = local.apprunner_route53_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "app_www" {
  count   = local.has_image && local.has_secret ? 1 : 0
  zone_id = data.aws_route53_zone.app[0].zone_id
  name    = "www.calore1.com"
  type    = "A"
  alias {
    name                   = aws_apprunner_custom_domain_association.app[0].dns_target
    zone_id                = local.apprunner_route53_zone_id
    evaluate_target_health = false
  }
}
