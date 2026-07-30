output "ecr_repository_url" {
  description = "ECR repository URL — push images here"
  value       = aws_ecr_repository.app.repository_url
}

output "dynamodb_table_name" {
  description = "Real AWS DynamoDB table name"
  value       = aws_dynamodb_table.app.name
}

output "app_url" {
  description = "Public HTTPS URL of the deployed app (empty until the App Runner service exists — see main.tf's has_image/has_secret gate)"
  value       = length(aws_apprunner_service.app) > 0 ? "https://${aws_apprunner_service.app[0].service_url}" : ""
}

output "apprunner_service_arn" {
  description = "App Runner service ARN — used by `make deploy` to trigger a new deployment"
  value       = length(aws_apprunner_service.app) > 0 ? aws_apprunner_service.app[0].arn : ""
}

output "custom_domain_url" {
  description = "Custom domain URL (empty until DNS validates and the association status is ACTIVE — check with `aws apprunner describe-custom-domains`)"
  value       = length(aws_apprunner_custom_domain_association.app) > 0 ? "https://calore1.com" : ""
}
