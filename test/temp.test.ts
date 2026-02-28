import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as Temp from "../lib/temp-stack";
import * as fs from "fs";

describe("TempStack Infrastructure", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new Temp.TempStack(app, "MyTestStack", {
      notificationEmail: "testemail@gmail.com",
      frontendDomainUrl: "testdomain.com",
      backendWebhookUrl: "testwebhook.com",
      cloudfrontPublicKey: fs.readFileSync("./test/public-key.pem", "utf8"),
      cloudfrontDomainName: "testdomain.com",
      cloudfrontDomainCertificateArn:
        "arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012",
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
      template.resourceCountIs("AWS::Lambda::Function", 5);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
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
          GenerateStringKey: "signature",
          SecretStringTemplate: '{"signature":""}',
        },
      });
    });
  });

  describe("Lambda Functions", () => {
    test("validateUploadedFilesLambda has correct configuration", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        MemorySize: 2560,
        Timeout: 150,
        Description: Match.stringLikeRegexp(".*validating.*files.*"),
        Environment: {
          Variables: {
            WEBHOOK_SECRET_ARN: {
              Ref: Match.anyValue(),
            },
          },
        },
      });
    });

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
    test("lambdaProcessingTimeAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 30000,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "File validation is taking too long",
      });
    });

    test("putDlqAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 2,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "There are more than 2 messages in the put sqs dlq",
        TreatMissingData: "ignore",
      });
    });

    test("deleteDlqAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 2,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription:
          "There are more than 2 messages in the delete sqs dlq",
        TreatMissingData: "ignore",
      });
    });

    test("putQueueDepthAlarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 20,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription:
          "Put queue has too many messages, processing is too slow",
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
    test("validateUploadedFilesLambda has SQS event source", () => {
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        BatchSize: 5,
        MaximumBatchingWindowInSeconds: 30,
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      });
    });

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
