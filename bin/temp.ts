#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { TempStack } from "../lib/temp-stack";

import * as dotenv from "dotenv";
import { GitHubActionsRoleStack } from "../lib/github-actions-role-stack";

dotenv.config();

const notificationEmail = process.env.NOTIFICATION_EMAIL;
if (!notificationEmail) {
  throw new Error("NOTIFICATION_EMAIL environment variable must be set");
}

const githubOrg = process.env.GITHUB_ORG;
const githubRepo = process.env.GITHUB_REPO;

if (!githubOrg) {
  throw new Error("GITHUB_ORG environment variable must be set");
}

if (!githubRepo) {
  throw new Error("GITHUB_REPO environment variable must be set");
}

const app = new cdk.App();

new GitHubActionsRoleStack(app, "GitHubActionsStack", {
  githubOrg,
  githubRepo,
});

new TempStack(app, "TempStack", {
  notificationEmail,
});
