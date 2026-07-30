# AWS / Docker — set AWS_ACCOUNT_ID and AWS_REGION before running deploy targets
AWS_REGION     ?= us-east-1
AWS_ACCOUNT_ID ?= $(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
ECR_BASE       := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE_TAG      ?= latest
GIT_SHA        := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

# ENV selects which .env.<ENV> file the app loads locally, and which
# name-prefixed AWS resources (calore1-$(ENV)-*) the deploy targets act on.
# Overridable: `make deploy ENV=prod`.
ENV ?= dev

TF_DIR := infra
PROJECT := calore1
REPO := $(PROJECT)-$(ENV)/app

# ──────────────────────────────────────────────────────────────────────────────
# Help (default target)
# ──────────────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "Calore 1 — available commands:"
	@echo ""
	@echo "  Local development"
	@echo "    make setup           npm install"
	@echo "    make dynamodb-up     Start DynamoDB Local (Docker)"
	@echo "    make dynamodb-down   Stop DynamoDB Local"
	@echo "    make db-create-table Create the DynamoDB table (idempotent)"
	@echo "    make db-migrate ADMIN_PASSWORD=...   Seed from data.json + create admin/driver logins"
	@echo "    make start           Run the app (http://localhost:4173)"
	@echo "    make test            Run the test suite (node:test)"
	@echo ""
	@echo "  AWS Deploy"
	@echo "    Prereq: AWS credentials configured (aws configure), and .env.dev filled in."
	@echo "    make tf-init         terraform init (run once per workspace)"
	@echo "    make tf-bootstrap    First-ever apply (before any image is pushed): ECR + DynamoDB + IAM only"
	@echo "    make tf-plan         terraform plan"
	@echo "    make tf-apply        terraform apply"
	@echo "    make tf-destroy      terraform destroy (tears down all infra)"
	@echo "    make ssm-put-secret  Store SESSION_SECRET in SSM (prompts for value, run once)"
	@echo "    make ecr-login       Authenticate Docker with ECR"
	@echo "    make build           Build the app Docker image"
	@echo "    make push            Push the app image to ECR"
	@echo "    make deploy          Full deploy: build, push, tf-apply, trigger App Runner deployment"
	@echo "    make logs            Tail App Runner application logs"
	@echo "    make url             Print the deployed app's URL"
	@echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Local development (thin wrappers around the npm scripts — package.json
# stays the source of truth for how each of these actually runs)
# ──────────────────────────────────────────────────────────────────────────────
.PHONY: setup
setup:
	npm install

.PHONY: dynamodb-up
dynamodb-up:
	npm run dynamodb:up

.PHONY: dynamodb-down
dynamodb-down:
	npm run dynamodb:down

.PHONY: db-create-table
db-create-table:
	npm run db:create-table

.PHONY: db-migrate
db-migrate:
	@test -n "$(ADMIN_PASSWORD)" || (echo "ERROR: set ADMIN_PASSWORD=<something>"; exit 1)
	node --env-file=.env.dev scripts/migrate-to-dynamodb.js --admin-password=$(ADMIN_PASSWORD)

.PHONY: start
start:
	npm start

.PHONY: test
test:
	npm test

# ──────────────────────────────────────────────────────────────────────────────
# AWS Deploy
# ──────────────────────────────────────────────────────────────────────────────
.PHONY: ecr-login
ecr-login:
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login --username AWS --password-stdin $(ECR_BASE)

.PHONY: build
build:
	docker build --platform linux/amd64 -t $(PROJECT)-app:$(IMAGE_TAG) --build-arg GIT_SHA=$(GIT_SHA) .

.PHONY: push
push: ecr-login
	$(eval APP_REPO := $(ECR_BASE)/$(REPO))
	docker tag $(PROJECT)-app:$(IMAGE_TAG) $(APP_REPO):$(IMAGE_TAG)
	docker push $(APP_REPO):$(IMAGE_TAG)
	@echo "Pushed: $(APP_REPO):$(IMAGE_TAG)"

# Store SESSION_SECRET in SSM (run once per environment).
.PHONY: ssm-put-secret
ssm-put-secret:
	@read -s -p "SESSION_SECRET value (blank to generate one): " SECRET && echo && \
	if [ -z "$$SECRET" ]; then SECRET=$$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"); fi && \
	aws ssm put-parameter \
		--name "/$(PROJECT)/$(ENV)/session_secret" \
		--value "$$SECRET" \
		--type SecureString \
		--region $(AWS_REGION) \
		--overwrite && \
	echo "Stored at /$(PROJECT)/$(ENV)/session_secret"

.PHONY: tf-init
tf-init:
	cd $(TF_DIR) && terraform init

# One-time, before any image has ever been pushed: creates ECR + DynamoDB +
# IAM only. Passes app_image="" explicitly so aws_apprunner_service's count
# stays 0 — App Runner can't reference an image tag that doesn't exist yet.
# Unlike tf-plan/tf-apply (used for every deploy after), this must NEVER pass
# a non-empty app_image, or it recreates the exact "ECR image doesn't exist"
# CREATE_FAILED bug this target exists to avoid.
.PHONY: tf-bootstrap
tf-bootstrap:
	cd $(TF_DIR) && terraform apply --auto-approve \
		-var environment=$(ENV) \
		-var app_image="" \
		-var session_secret_ssm_arn=$(SESSION_SECRET_SSM_ARN)

.PHONY: tf-plan
tf-plan:
	cd $(TF_DIR) && terraform plan -out=tfplan \
		-var environment=$(ENV) \
		-var app_image=$(ECR_BASE)/$(REPO):$(IMAGE_TAG) \
		-var session_secret_ssm_arn=$(SESSION_SECRET_SSM_ARN)

.PHONY: tf-apply
tf-apply: tf-plan
	cd $(TF_DIR) && terraform apply --auto-approve tfplan

.PHONY: tf-destroy
tf-destroy:
	cd $(TF_DIR) && terraform destroy -var environment=$(ENV)

# Resolved lazily (only when a target actually needs it) so plain `make
# help`/`make build` don't require AWS credentials or an existing parameter.
SESSION_SECRET_SSM_ARN ?= $(shell aws ssm get-parameter --name "/$(PROJECT)/$(ENV)/session_secret" --region $(AWS_REGION) --query Parameter.ARN --output text 2>/dev/null)

# Full deploy: build, push, apply terraform (creating the App Runner
# service on first run, or updating its config on later runs), then
# explicitly trigger a fresh deployment of the just-pushed image — App
# Runner's auto_deployments_enabled is off (see infra/main.tf), so pushing
# a new image alone does not roll it out.
.PHONY: deploy
deploy: build push tf-apply
	@ARN=$$(cd $(TF_DIR) && terraform output -raw apprunner_service_arn 2>/dev/null); \
	if [ -z "$$ARN" ]; then echo "No App Runner service yet — check tf-apply output above."; exit 1; fi; \
	aws apprunner start-deployment --service-arn "$$ARN" --region $(AWS_REGION) --query 'OperationId' --output text
	@echo ""
	@$(MAKE) url

.PHONY: logs
logs:
	@ARN=$$(cd $(TF_DIR) && terraform output -raw apprunner_service_arn 2>/dev/null); \
	if [ -z "$$ARN" ]; then echo "No App Runner service yet."; exit 1; fi; \
	SERVICE_ID=$$(echo "$$ARN" | awk -F'/' '{print $$(NF-1)"/"$$NF}'); \
	aws logs tail "/aws/apprunner/$(PROJECT)-$(ENV)-app/$$SERVICE_ID/application" --follow --region $(AWS_REGION)

.PHONY: url
url:
	@cd $(TF_DIR) && terraform output -raw app_url 2>/dev/null | grep -q . && \
		terraform output -raw app_url || \
		echo "Run 'make tf-apply' first to get the URL"
