import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  Role,
  WebIdentityPrincipal,
  ManagedPolicy,
  PolicyStatement,
  Effect,
  FederatedPrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnOutput } from "aws-cdk-lib/core";

interface GitHubActionsRoleStackProps extends cdk.StackProps {
  githubOrg: string;
  githubRepo: string;
}

export class GitHubActionsRoleStack extends cdk.Stack {
  public readonly role: Role;

  constructor(
    scope: Construct,
    id: string,
    props: GitHubActionsRoleStackProps,
  ) {
    super(scope, id, props);

    const { githubOrg, githubRepo } = props;

    const githubOidcProviderArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;

    this.role = new Role(this, "GitHubActionsDeployRole", {
      roleName: `github-actions-temp-deploy-role`,
      description: `Role for GitHub Actions to deploy temp infrastructure`,
      assumedBy: new FederatedPrincipal(
        githubOidcProviderArn,
        {
          StringEquals: {
            "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          },
          StringLike: {
            "token.actions.githubusercontent.com:sub": `repo:${githubOrg}/${githubRepo}:*`,
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    this.role.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AWSCloudFormationFullAccess"),
    );

    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "s3:*",
          "lambda:*",
          "iam:GetRole",
          "iam:PassRole",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:GetRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateRole",
          "iam:UpdateAssumeRolePolicy",
          "sqs:*",
          "sns:*",
          "secretsmanager:*",
          "cloudwatch:*",
          "logs:*",
          "ecr:*",
          "ssm:GetParameter",
          "ssm:PutParameter",
        ],
        resources: ["*"],
      }),
    );

    this.role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "iam:CreateUser",
          "iam:DeleteUser",
          "iam:GetUser",
          "iam:TagUser",
          "iam:ListAttachedUserPolicies",
          "iam:AttachUserPolicy",
          "iam:DetachUserPolicy",
          "iam:PutUserPolicy",
          "iam:DeleteUserPolicy",
        ],
        resources: [
          `arn:aws:iam::${this.account}:user/TempStack-*applicationUser*`,
        ],
      }),
    );

    new CfnOutput(this, "GitHubActionsRoleArn", {
      value: this.role.roleArn,
      description: `GitHub Actions deployment role ARN`,
      exportName: `GitHubActionsRoleArn`,
    });
  }
}
