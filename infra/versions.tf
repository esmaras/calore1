terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Uncomment and configure once you have an S3 backend bucket.
  # backend "s3" {
  #   bucket = "calore1-terraform-state"
  #   key    = "calore1/terraform.tfstate"
  #   region = "us-east-1"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "calore1"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
