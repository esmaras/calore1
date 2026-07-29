variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment (dev, prod)"
  type        = string
  default     = "dev"
}

variable "project" {
  description = "Project name used in resource naming"
  type        = string
  default     = "calore1"
}

variable "app_image" {
  description = "Full ECR image URI for the app (e.g. 123456789.dkr.ecr.us-east-1.amazonaws.com/calore1-dev/app:latest). Leave empty on first apply — App Runner needs the ECR repo to exist before an image can be pushed; set this and re-apply once you've built and pushed one."
  type        = string
  default     = ""
}

variable "session_secret_ssm_arn" {
  description = "ARN of the SSM SecureString parameter holding SESSION_SECRET. Create it once with `make ssm-put-secret`, then pass its ARN here (the make url/tf targets read it from `aws ssm` automatically — see Makefile)."
  type        = string
  default     = ""
}
