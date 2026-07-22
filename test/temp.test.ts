import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as Temp from "../lib/temp-stack";

describe("TempStack Infrastructure", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new Temp.TempStack(app, "MyTestStack", {
      env: { account: "123456789012", region: "us-east-1" },
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
      largeFileScannerAmiId: "ami-12345678",
    });
    template = Template.fromStack(stack);
  });

  describe("Resource Counts", () => {
    test("creates correct number of core resources", () => {
      template.resourceCountIs("AWS::IAM::User", 1);
      template.resourceCountIs("AWS::SecretsManager::Secret", 1);
      template.resourceCountIs("AWS::S3::Bucket", 1);
      template.resourceCountIs("AWS::SQS::Queue", 10);
      template.resourceCountIs("AWS::SNS::Topic", 1);
      template.resourceCountIs("AWS::Lambda::Function", 5);
      template.resourceCountIs("AWS::CloudWatch::Alarm", 10);
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
                DaysAfterInitiation: 1,
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
            CLOUDFLARE_BYPASS_SECRET: "test-secret",
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
        Threshold: 1,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "There are messages in the put sqs dlq",
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

  describe("Large File Scanner", () => {
    test("VPC has correct configuration", () => {
      template.hasResourceProperties("AWS::EC2::VPC", {
        EnableDnsHostnames: true,
        EnableDnsSupport: true,
      });
    });

    test("VPC has S3 gateway endpoint", () => {
      template.hasResourceProperties("AWS::EC2::VPCEndpoint", {
        VpcEndpointType: "Gateway",
      });
    });

    test("security group allows all outbound and no inbound", () => {
      template.hasResourceProperties("AWS::EC2::SecurityGroup", {
        GroupDescription: "Large file scanner firewall",
        SecurityGroupEgress: Match.arrayWith([
          Match.objectLike({
            CidrIp: "0.0.0.0/0",
            IpProtocol: "-1",
          }),
        ]),
      });
    });

    test("launch template uses correct instance type and requires IMDSv2", () => {
      template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
        LaunchTemplateData: {
          InstanceType: "c5.2xlarge",
          MetadataOptions: {
            HttpTokens: "required",
          },
          ImageId: "ami-12345678",
        },
      });
    });

    test("launch template uses spot instances", () => {
      template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
        LaunchTemplateData: {
          InstanceMarketOptions: {
            MarketType: "spot",
            SpotOptions: {
              InstanceInterruptionBehavior: "terminate",
              SpotInstanceType: "one-time",
            },
          },
        },
      });
    });

    test("ASG has correct capacity bounds", () => {
      template.hasResourceProperties("AWS::AutoScaling::AutoScalingGroup", {
        MinSize: "0",
        MaxSize: "5",
      });
    });

    test("ASG lifecycle hook has correct termination configuration", () => {
      template.hasResourceProperties("AWS::AutoScaling::LifecycleHook", {
        LifecycleTransition: "autoscaling:EC2_INSTANCE_TERMINATING",
        HeartbeatTimeout: 18000,
        DefaultResult: "CONTINUE",
      });
    });

    test("scanner role can assume EC2 service principal", () => {
      template.hasResourceProperties("AWS::IAM::Role", {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
            }),
          ]),
        },
        Description:
          "Least-privilege role for large file scanner EC2 instances",
      });
    });

    test("multipart content queue has correct configuration", () => {
      template.hasResourceProperties("AWS::SQS::Queue", {
        VisibilityTimeout: 21600,
        MessageRetentionPeriod: 172800,
        RedrivePolicy: Match.objectLike({
          maxReceiveCount: 15,
        }),
      });
    });

    test("multipart content DLQ alarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 1,
        EvaluationPeriods: 2,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription:
          "There are messages in the multipart content uploaded sqs dlq",
        TreatMissingData: "ignore",
      });
    });

    test("scanner high instance count alarm is configured correctly", () => {
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Threshold: 3,
        EvaluationPeriods: 1,
        ComparisonOperator: "GreaterThanOrEqualToThreshold",
        AlarmDescription: "Large file scanner has scaled to 3+ instances",
        Namespace: "AWS/AutoScaling",
        MetricName: "GroupInServiceInstances",
      });
    });
  });

  describe("S3 Event Notifications", () => {
    test("S3 bucket has POST, multipart complete, and DELETE event notifications", () => {
      template.hasResourceProperties("Custom::S3BucketNotifications", {
        NotificationConfiguration: {
          QueueConfigurations: Match.arrayWith([
            Match.objectLike({
              Events: Match.arrayWith(["s3:ObjectCreated:Post"]),
            }),
            Match.objectLike({
              Events: Match.arrayWith([
                "s3:ObjectCreated:CompleteMultipartUpload",
              ]),
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
