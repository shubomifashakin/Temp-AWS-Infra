import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as Temp from "../lib/temp-stack";

describe("TempStack Infrastructure", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new Temp.TempStack(app, "MyTestStack", {
      notificationEmail: "testemail@gmail.com",
      frontendDomainUrl: "testdomain.com",
      backendWebhookUrl: "testwebhook.com",
      cloudfrontPublicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2a2rwplBQLzHPZe5TNJK
JLepPP8LxLqDg6P5rFLJ2DPXZ7rwnbA0r/kEgY9GqJReSLvlBGLBcSmJNQp0h0A5
kVleBE+YbVLOajH4r3jXJpSg1Y0Z6xdX5+dn9ZBH9EJCVLA3Y5sJHwi6tTGdM0Lm
QYR2iShCEgfD7n5xJYqrDLvM7uh0j5bSnP3pHx/c9d3R2P0D5LALWzrjHhOkEI2K
b0MFLs0gL+M2NXPjfJRNg0FEqRIFZRJb+GhLpxuHJmrn2lfIKN2hKJnVOhXS8nYA
VGS3ZO9uT5lHG6g6e7HfT8MhR7mSXz6/OjnZ8Rp7U/7fhMQFpMj7BOVk7iqIpOe4
xwIDAQAB
-----END PUBLIC KEY-----`,
      cloudfrontDomainName: "testdomain.com",
      cloudfrontDomainCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012",
      cloudflareBypassSecret: "test-secret",
    });
    template = Template.fromStack(stack);
  });

  describe("Resource Counts", () => {
    test("creates correct number of resources", () => {
      template.resourceCountIs("AWS::IAM::User", 1);
      template.resourceCountIs("AWS::SecretsManager::Secret", 1);
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::SQS::Queue", 8);
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.resourceCountIs("AWS::Lambda::Function", 4);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
    });
  });

  describe("S3 Bucket", () => {
    test("has correct lifecycle rules", () => {
      template.hasResourceProperties("AWS::S3::Bucket", {
        LifecycleConfiguration: {
          Rules: [
            {
              Status: "Enabled",
              ExpirationInDays: 7,
              TagFilters: [
                {
                  Key: "lifetime",
                  Value: "short",
                },
              ],
            },
            {
              Status: "Enabled",
              ExpirationInDays: 14,
              TagFilters: [
                {
                  Key: "lifetime",
                  Value: "medium",
                },
              ],
            },
            {
              Status: "Enabled",
              ExpirationInDays: 31,
              TagFilters: [
                {
                  Key: "lifetime",
                  Value: "long",
                },
              ],
            },

            {
              Status: "Enabled",
              ExpirationInDays: 31,
              Prefix: "access-logs/",
            },
            {
              Status: "Enabled",
              Prefix: "uploads/",
              AbortIncompleteMultipartUpload: {
                DaysAfterInitiation: 2,
              },
            },
          ],
        },
      });
    });

    test("enforces SSL", () => {
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Principal: Match.anyValue(),
              Action: "s3:*",
              Condition: {
                Bool: {
                  "aws:SecureTransport": "false",
                },
              },
            }),
          ]),
        },
      });
    });
  });

  describe("Secrets Manager", () => {
    test("webhook secret has correct configuration", () => {
      template.hasResourceProperties("AWS::SecretsManager::Secret", {
        Description: "Secret for webhook authentication",
        GenerateSecretString: {
          PasswordLength: 32,
          IncludeSpace: false,
          GenerateStringKey: "secret",
          SecretStringTemplate: '{"secret":""}',
        },
      });
    });
  });

  describe("Lambda Functions", () => {
    test("removeDeletedFilesLambda has correct configuration", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Runtime: "nodejs24.x",
        Handler: "index.handler",
        MemorySize: 512,
        Timeout: 60,
        Environment: {
          Variables: {
            WEBHOOK_SECRET_ARN: {
              Ref: Match.anyValue(),
            },
            CLOUDFLARE_BYPASS_SECRET: "test-secret",
          },
        },
      });
    });
  });

  describe("SQS Queues", () => {
    test("Dead Letter Queues have correct configuration", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        MessageRetentionPeriod: 604800,
        RedrivePolicy: Match.absent(),
      });
    });
  });

  describe("CloudWatch Alarms", () => {
    test("scanFilesDlqAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 1,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "There are messages in the scan files sqs dlq",
        TreatMissingData: "ignore",
      });
    });

    test("deleteDlqAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 1,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "There are messages in the delete sqs dlq",
        TreatMissingData: "ignore",
      });
    });

    test("scanFilesQueueDepthAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 20,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription:
          "scanFilesQueue has too many messages, processing is too slow",
      });
    });

    test("deleteQueueDepthAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 20,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription:
          "Delete queue has too many messages, processing is too slow",
      });
    });

    test("alarms send notifications to SNS topic", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        AlarmActions: Match.arrayWith([
          {
            Ref: Match.stringLikeRegexp(".*notificationTopic.*"),
          },
        ]),
      });
    });
  });

  describe("SNS Topic", () => {
    test("notification topic has email subscription", () => {
      template.hasResourceProperties("AWS::SNS::Subscription", {
        Protocol: "email",
        Endpoint: "testemail@gmail.com",
      });
    });
  });

  describe("CloudFront Distribution", () => {
    test("distribution has correct domain name", () => {
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          Aliases: ["testdomain.com"],
          PriceClass: "PriceClass_200",
        },
      });
    });
  });

  describe("IAM Permissions", () => {
    test("application user has S3 permissions", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: Match.arrayWith([Match.stringLikeRegexp("s3:.*")]),
            }),
          ]),
        },
      });
    });

    test("Lambda functions have necessary permissions", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Principal: {
                Service: "lambda.amazonaws.com",
              },
              Action: "sts:AssumeRole",
            }),
          ]),
        },
      });
    });
  });

  describe("Event Source Mappings", () => {
    test("removeDeletedFilesLambda has SQS event source", () => {
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        BatchSize: 10,
        MaximumBatchingWindowInSeconds: 60,
      });
    });
  });

  describe("S3 Event Notifications", () => {
    test("S3 bucket has PUT and DELETE event notifications", () => {
      template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: {
          QueueConfigurations: Match.arrayWith([
            Match.objectLike({
              Events: Match.arrayWith(["s3:ObjectCreated:Post"]),
            }),
            Match.objectLike({
              Events: Match.arrayWith(["s3:LifecycleExpiration:Delete"]),
            }),
          ]),
        },
      });
    });
  });
});
