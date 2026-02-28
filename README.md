# Temp AWS Infra

## Description

This repository contains the AWS CDK infrastructure code for Temp, a secure ephemeral file sharing application. It provisions and manages all AWS resources required to run the application.

## AWS Services Used

| Service             | Purpose                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| **S3**              | Stores uploaded files with lifecycle policies for automatic expiration             |
| **CloudFront**      | CDN for serving files securely via signed URLs/cookies                             |
| **SQS**             | Queues for async processing of file uploads, deletions, and infected file handling |
| **Lambda**          | Background workers for file validation, malware scanning, and deletion             |
| **Secrets Manager** | Stores the webhook signature secret for Lambda → API communication                 |
| **SNS**             | To send alarm notifications to myself                                              |
| **CloudWatch**      | Monitors queue depths, Lambda processing times, and DLQ message counts             |
| **IAM**             | Manages permissions for GitHub Actions deployments and the application user        |
| **ACM**             | TLS certificate for the CloudFront custom domain                                   |
| **ECR**             | Stores the Docker image for the file validation Lambda                             |

## Project Structure

```
temp-aws-infra/
├── bin/                  # CDK app entrypoint
├── lib/                  # Stack and construct definitions
│   ├── temp-stack.ts     # Main application stack
│   └── github-actions-role-stack.ts  # CI/CD IAM role stack
├── test/                 # CDK unit tests
├── workers/              # Worker Lambda code
│   ├── handleDeletedFile.ts  # Lambda function to handle deleted files
│   ├── handleInfectedFiles.ts  # Lambda function to handle infected files
│   └── handleUserRequestedDelete.ts  # Lambda function to handle user file delete requests
│   └── validateUploadedFiles.ts  # Lambda function to validate uploaded files
├── docs/                 # ADRs and architecture diagrams
│   └── images/           # Architecture diagrams
├── cdk.json              # CDK configuration
└── README.md
```

## Security & Best Practices

This project uses [cdk-nag](https://github.com/cdklabs/cdk-nag) to enforce AWS security best practices at synth time. It runs automatically when you execute `cdk synth` or `cdk diff` and will fail if any unacknowledged security issues are found.

Any suppressed rules are documented with explicit reasons directly in the CDK code.

## Deployment

### Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 24+
- AWS CDK CLI (`npm install -g aws-cdk`)

### First-time Setup (per account)

These steps are required once per AWS account before the pipeline can deploy:

1. Configure your AWS credentials locally for the target account
2. Bootstrap the CDK toolkit:

```bash
npx cdk bootstrap
```

3. Deploy the GitHub Actions IAM role:

```bash
npx cdk deploy GitHubActionsStack
```

4. Copy the output role ARN and add it as `AWS_IAM_ROLE_ARN` in your GitHub environment secrets

### Environment Variables

Copy the example env file and fill in the required values:

```bash
cp .env.example .env
```

| Variable                            | Description                                      |
| ----------------------------------- | ------------------------------------------------ |
| `NOTIFICATION_EMAIL`                | Email address for CloudWatch alarm notifications |
| `GITHUB_ORG`                        | GitHub organisation name                         |
| `GITHUB_REPO`                       | GitHub repository name                           |
| `CLOUDFRONT_DOMAIN_NAME`            | Custom domain for the CloudFront distribution    |
| `CLOUDFRONT_DOMAIN_CERTIFICATE_ARN` | ACM certificate ARN for the custom domain        |
| `CLOUDFRONT_PUBLIC_KEY`             | Cloudfront public key                            |
| `BACKEND_DOMAIN_URL`                | Domain of the NestJS backend                     |
| `BACKEND_WEBHOOK_URL`               | Webhook URL of the NestJS backend                |

### Local Deployment

```bash
# Install dependencies
npm install

# Preview changes
npx cdk diff

# Deploy all stacks
npx cdk deploy --all

# Deploy a specific stack
npx cdk deploy TempStack
```

### CI/CD

Deployments are automated via GitHub Actions. Pushing to `dev` deploys to the development environment and pushing to `main` deploys to production. See `.github/workflows/deploy.yml` for the full pipeline configuration.

After deploying the infrastructure you would need to manually create the following resources in the AWS Management Console:

- The access keys for the `ApplicationUser` created by `TempStack`
- Put your webhook signature in the `webhookSignatureSecret` secret

## Testing

```bash
# Run unit tests
npm run test

# Run tests in watch mode
npm run test:watch
```

## Useful Commands

- `npm run build` — compile TypeScript to JS
- `npm run watch` — watch for changes and compile
- `npm run test` — run Jest unit tests
- `npx cdk synth` — synthesize the CloudFormation template
- `npx cdk diff` — compare deployed stack with current state
- `npx cdk deploy` — deploy to your default AWS account/region
