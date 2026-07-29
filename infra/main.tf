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

# Lets the App Runner build/access role fetch SESSION_SECRET from SSM at
# container start (runtime_environment_secrets below) — populate the
# parameter itself with `make ssm-put-secret` before the first real apply.
data "aws_iam_policy_document" "apprunner_ssm_secrets" {
  count = local.has_secret ? 1 : 0
  statement {
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = [var.session_secret_ssm_arn]
  }
}

resource "aws_iam_policy" "apprunner_ssm_secrets" {
  count  = local.has_secret ? 1 : 0
  name   = "${local.name_prefix}-apprunner-ssm-secrets"
  policy = data.aws_iam_policy_document.apprunner_ssm_secrets[0].json
}

resource "aws_iam_role_policy_attachment" "apprunner_access_ssm_secrets" {
  count      = local.has_secret ? 1 : 0
  role       = aws_iam_role.apprunner_access.name
  policy_arn = aws_iam_policy.apprunner_ssm_secrets[0].arn
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
          # DYNAMODB_ENDPOINT intentionally omitted — unset means the app
          # talks to real AWS DynamoDB (see server/db/client.js).
        }
        runtime_environment_secrets = {
          SESSION_SECRET = var.session_secret_ssm_arn
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

  depends_on = [aws_iam_role_policy_attachment.apprunner_access_ecr, aws_iam_role_policy_attachment.apprunner_access_ssm_secrets]
}
