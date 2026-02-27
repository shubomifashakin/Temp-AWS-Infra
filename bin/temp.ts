#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { TempStack } from "../lib/temp-stack";

import * as dotenv from "dotenv";
import { GitHubActionsRoleStack } from "../lib/github-actions-role-stack";
import * as fs from "fs";
import { AwsSolutionsChecks } from "cdk-nag/lib/packs/aws-solutions";
dotenv.config();

const notificationEmail = process.env.NOTIFICATION_EMAIL;
if (!notificationEmail) {
  throw new Error("NOTIFICATION_EMAIL environment variable must be set");
}

const githubOrg = process.env.GITHUB_ORG;
const githubRepo = process.env.GITHUB_REPO;
const domainName = process.env.CLOUDFRONT_DOMAIN_NAME;
const cloudfrontDomainCertificateArn =
  process.env.CLOUDFRONT_DOMAIN_CERTIFICATE_ARN;
const cloudfrontPublicKey = fs.readFileSync("cf-public-key.pem", "utf-8");
const backendDomainUrl = process.env.BACKEND_DOMAIN_URL;

if (!githubOrg || !githubRepo) {
  throw new Error("GITHUB_ORG or GITHUB_REPO environment variable must be set");
}

if (!domainName || !cloudfrontPublicKey) {
  throw new Error(
    "CLOUDFRONT_DOMAIN_NAME or CLOUDFRONT_PUBLIC_KEY environment variable must be set",
  );
}

if (!cloudfrontDomainCertificateArn) {
  throw new Error(
    "CLOUDFRONT_DOMAIN_CERTIFICATE_ARN environment variable must be set",
  );
}

if (!backendDomainUrl) {
  throw new Error("BACKEND_DOMAIN_URL environment variable must be set");
}

const app = new cdk.App();

new GitHubActionsRoleStack(app, "GitHubActionsStack", {
  githubOrg,
  githubRepo,
});

new TempStack(app, "TempStack", {
  notificationEmail,
  cloudfrontDomainName: domainName,
  cloudfrontPublicKey,
  cloudfrontDomainCertificateArn,
  backendDomainUrl,
});

cdk.Aspects.of(app).add(
  new AwsSolutionsChecks({
    verbose: true,
  }),
);
