#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { TempStack } from "../lib/temp-stack";

import * as dotenv from "dotenv";
import { GitHubActionsRoleStack } from "../lib/github-actions-role-stack";
import { AwsSolutionsChecks } from "cdk-nag/lib/packs/aws-solutions";
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable must be set`);
  }
  return value;
}

const env = {
  notificationEmail: requireEnv("NOTIFICATION_EMAIL"),
  githubOrg: requireEnv("REPO_OWNER"),
  githubRepo: requireEnv("REPO_NAME"),
  cloudfrontDomainName: requireEnv("CLOUDFRONT_DOMAIN_NAME"),
  cloudfrontDomainCertificateArn: requireEnv(
    "CLOUDFRONT_DOMAIN_CERTIFICATE_ARN",
  ),
  cloudfrontPublicKey: Buffer.from(
    requireEnv("CLOUDFRONT_PUBLIC_KEY_BASE64"),
    "base64",
  ).toString("utf-8"),
  frontendDomainUrl: requireEnv("FRONTEND_DOMAIN_URL"),
  backendWebhookUrl: requireEnv("BACKEND_WEBHOOK_URL"),
  cloudflareBypassSecret: requireEnv("CLOUDFLARE_BYPASS_SECRET"),
};

const app = new cdk.App();

new GitHubActionsRoleStack(app, "GitHubActionsStack", {
  githubOrg: env.githubOrg,
  githubRepo: env.githubRepo,
});

new TempStack(app, "TempStack", {
  notificationEmail: env.notificationEmail,
  cloudfrontDomainName: env.cloudfrontDomainName,
  cloudfrontPublicKey: env.cloudfrontPublicKey,
  cloudfrontDomainCertificateArn: env.cloudfrontDomainCertificateArn,
  frontendDomainUrl: env.frontendDomainUrl,
  backendWebhookUrl: env.backendWebhookUrl,
  cloudflareBypassSecret: env.cloudflareBypassSecret,
});

cdk.Aspects.of(app).add(
  new AwsSolutionsChecks({
    verbose: true,
    logIgnores: true,
  }),
);
