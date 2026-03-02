import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import {
  BlockPublicAccess,
  Bucket,
  EventType,
  HttpMethods,
} from "aws-cdk-lib/aws-s3";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  Runtime,
  DockerImageCode,
  DockerImageFunction,
} from "aws-cdk-lib/aws-lambda";
import { SqsDestination } from "aws-cdk-lib/aws-s3-notifications";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Topic } from "aws-cdk-lib/aws-sns";
import {
  Alarm,
  ComparisonOperator,
  Stats,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { User } from "aws-cdk-lib/aws-iam";
import { CfnOutput } from "aws-cdk-lib/core";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";

import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

interface TempConstructProps {
  notificationEmail: string;
  cloudfrontPublicKey: string;
  cloudfrontDomainName: string;
  cloudfrontDomainCertificateArn: string;
  frontendDomainUrl: string;
  backendWebhookUrl: string;
}

class TempInfraConstruct extends Construct {
  public readonly s3Bucket: Bucket;
  public readonly infectedFilesQueue: Queue;
  public readonly infectedFilesDlq: Queue;
  public readonly userRequestedDeleteQueue: Queue;
  public readonly userRequestedDeleteDlq: Queue;
  public readonly putEventsSqsQueue: Queue;
  public readonly putSqsDlq: Queue;
  public readonly deleteEventsSqsQueue: Queue;
  public readonly deleteSqsDlq: Queue;
  public readonly infectedFilesDeleteLambda: NodejsFunction;
  public readonly userRequestedDeleteLambda: NodejsFunction;
  public readonly validateUploadedFilesLambda: DockerImageFunction;
  public readonly removeDeletedFilesLambda: NodejsFunction;
  public readonly notificationTopic: Topic;
  public readonly lambdaProcessingTimeAlarm: Alarm;
  public readonly putDlqAlarm: Alarm;
  public readonly deleteDlqAlarm: Alarm;
  public readonly putQueueDepthAlarm: Alarm;
  public readonly deleteQueueDepthAlarm: Alarm;

  private readonly applicationUser: User;
  private readonly webhookSignatureSecret: Secret;

  constructor(scope: Construct, id: string, props: TempConstructProps) {
    super(scope, id);

    this.applicationUser = new User(this, "applicationUser");

    this.webhookSignatureSecret = new Secret(this, "webhookSignatureSecret", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      description: "Secret for webhook authentication",
      generateSecretString: {
        passwordLength: 32,
        includeSpace: false,
        generateStringKey: "secret",
        secretStringTemplate: JSON.stringify({
          secret: "",
        }),
      },
    });

    this.s3Bucket = new Bucket(this, "tempS3Bucket", {
      enforceSSL: true,
      serverAccessLogsPrefix: "access-logs/",
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          allowedOrigins: [props.frontendDomainUrl],
          allowedMethods: [HttpMethods.POST, HttpMethods.PUT],
        },
      ],
      lifecycleRules: [
        {
          enabled: true,
          tagFilters: { lifetime: "short" },
          expiration: cdk.Duration.days(7),
        },
        {
          enabled: true,
          tagFilters: { lifetime: "medium" },
          expiration: cdk.Duration.days(14),
        },
        {
          enabled: true,
          tagFilters: { lifetime: "long" },
          expiration: cdk.Duration.days(31),
        },
        {
          enabled: true,
          prefix: "access-logs/",
          expiration: cdk.Duration.days(31),
        },
      ],
    });

    this.infectedFilesDlq = new Queue(this, "infectedFilesDlq", {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.infectedFilesQueue = new Queue(this, "infectedFilesQueue", {
      enforceSSL: true,
      visibilityTimeout: cdk.Duration.minutes(3),
      retentionPeriod: cdk.Duration.minutes(10),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.infectedFilesDlq,
      },
    });

    this.userRequestedDeleteDlq = new Queue(this, "userRequestedDeleteDlq", {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.userRequestedDeleteQueue = new Queue(
      this,
      "userRequestedDeleteQueue",
      {
        enforceSSL: true,
        visibilityTimeout: cdk.Duration.minutes(3),
        retentionPeriod: cdk.Duration.minutes(10),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        deadLetterQueue: {
          maxReceiveCount: 3,
          queue: this.userRequestedDeleteDlq,
        },
      },
    );

    this.putSqsDlq = new Queue(this, "putSqsDlq", {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deleteSqsDlq = new Queue(this, "deleteSqsDlq", {
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.putEventsSqsQueue = new Queue(this, "putEventsSqsQueue", {
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retentionPeriod: cdk.Duration.minutes(10),
      visibilityTimeout: cdk.Duration.minutes(3),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.putSqsDlq,
      },
    });

    this.deleteEventsSqsQueue = new Queue(this, "deleteEventsSqsQueue", {
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retentionPeriod: cdk.Duration.minutes(10),
      visibilityTimeout: cdk.Duration.minutes(1.5),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.deleteSqsDlq,
      },
    });

    this.infectedFilesDeleteLambda = new NodejsFunction(
      this,
      "infectedFilesDeleteLambda",
      {
        runtime: Runtime.NODEJS_24_X,
        description:
          "This is responsible for deleting infected files from the s3 bucket.",
        memorySize: 256,
        timeout: cdk.Duration.minutes(1.5),
        handler: "index.handler",
        entry: "./workers/handleInfectedFiles.ts",
        retryAttempts: 2,
        environment: {
          BUCKET_NAME: this.s3Bucket.bucketName,
        },
        logGroup: new LogGroup(this, "infectedFilesDeleteLambdaGroup", {
          retention: RetentionDays.FIVE_DAYS,
        }),
      },
    );

    this.userRequestedDeleteLambda = new NodejsFunction(
      this,
      "userRequestedDeleteLambda",
      {
        runtime: Runtime.NODEJS_24_X,
        description:
          "This is responsible for deleting files users explicitly requested to be deleted",
        memorySize: 256,
        timeout: cdk.Duration.minutes(1.5),
        handler: "index.handler",
        entry: "./workers/handleUserRequestedDelete.ts",
        retryAttempts: 2,
        environment: {
          BUCKET_NAME: this.s3Bucket.bucketName,
        },
        logGroup: new LogGroup(this, "userRequestedDeleteLambdaLogGroup", {
          retention: RetentionDays.FIVE_DAYS,
        }),
      },
    );

    this.validateUploadedFilesLambda = new DockerImageFunction(
      this,
      "validateUploadedFilesLambda",
      {
        description:
          "This is responsible for validating the files that were put/uploaded to the s3 bucket & updating the status of the files",
        code: DockerImageCode.fromImageAsset(
          "./workers/validateUploadedFiles",
          { file: "Dockerfile" },
        ),
        retryAttempts: 2,
        memorySize: 1024 * 2.5,
        timeout: cdk.Duration.minutes(2.5),
        ephemeralStorageSize: cdk.Size.gibibytes(2),
        environment: {
          WEBHOOK_URL: props.backendWebhookUrl,
          WEBHOOK_SECRET_ARN: this.webhookSignatureSecret.secretArn,
          INFECTED_QUEUE_URL: this.infectedFilesQueue.queueUrl,
        },
        logGroup: new LogGroup(this, "validateUploadedFilesLambdaLogGroup", {
          retention: RetentionDays.FIVE_DAYS,
        }),
      },
    );

    this.removeDeletedFilesLambda = new NodejsFunction(
      this,
      "removeDeletedFilesLambda",
      {
        runtime: Runtime.NODEJS_24_X,
        handler: "index.handler",
        entry: "./workers/handleDeletedFile.ts",
        description:
          "This is responsible for updating the status of the files that were deleted from the s3 bucket",
        memorySize: 512,
        retryAttempts: 2,
        timeout: cdk.Duration.minutes(1),
        environment: {
          WEBHOOK_SECRET_ARN: this.webhookSignatureSecret.secretArn,
        },
        logGroup: new LogGroup(this, "removeDeletedFilesLambdaLogGroup", {
          retention: RetentionDays.FIVE_DAYS,
        }),
      },
    );

    this.userRequestedDeleteLambda.addEventSource(
      new SqsEventSource(this.userRequestedDeleteQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxBatchingWindow: cdk.Duration.seconds(30),
      }),
    );

    this.infectedFilesDeleteLambda.addEventSource(
      new SqsEventSource(this.infectedFilesQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxBatchingWindow: cdk.Duration.seconds(30),
      }),
    );

    this.validateUploadedFilesLambda.addEventSource(
      new SqsEventSource(this.putEventsSqsQueue, {
        batchSize: 2,
        reportBatchItemFailures: true,
        maxBatchingWindow: cdk.Duration.seconds(30),
      }),
    );

    this.removeDeletedFilesLambda.addEventSource(
      new SqsEventSource(this.deleteEventsSqsQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.minutes(1),
      }),
    );

    this.infectedFilesQueue.grantSendMessages(this.validateUploadedFilesLambda);

    this.putEventsSqsQueue.grantConsumeMessages(
      this.validateUploadedFilesLambda,
    );
    this.deleteEventsSqsQueue.grantConsumeMessages(
      this.removeDeletedFilesLambda,
    );

    this.s3Bucket.addEventNotification(
      EventType.OBJECT_CREATED_POST,
      new SqsDestination(this.putEventsSqsQueue),
    );

    this.s3Bucket.addEventNotification(
      EventType.LIFECYCLE_EXPIRATION_DELETE,
      new SqsDestination(this.deleteEventsSqsQueue),
    );

    this.s3Bucket.grantPut(this.applicationUser);
    this.s3Bucket.grantRead(this.applicationUser);
    this.s3Bucket.grantRead(this.validateUploadedFilesLambda);
    this.s3Bucket.grantDelete(this.userRequestedDeleteLambda);
    this.s3Bucket.grantDelete(this.infectedFilesDeleteLambda);

    this.userRequestedDeleteQueue.grantSendMessages(this.applicationUser);

    this.webhookSignatureSecret.grantRead(this.removeDeletedFilesLambda);
    this.webhookSignatureSecret.grantRead(this.validateUploadedFilesLambda);

    //observability stuff
    this.notificationTopic = new Topic(this, "notificationTopic", {
      enforceSSL: true,
      displayName: "File Processing Service Alerts",
    });

    this.notificationTopic.addSubscription(
      new EmailSubscription(props.notificationEmail),
    );

    this.lambdaProcessingTimeAlarm = new Alarm(
      this,
      "lambdaProcessingTimeAlarm",
      {
        evaluationPeriods: 1,
        threshold: cdk.Duration.seconds(30).toMilliseconds(),
        metric: this.validateUploadedFilesLambda.metricDuration({
          period: cdk.Duration.minutes(2),
        }),
        comparisonOperator:
          ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: "File validation is taking too long",
      },
    );

    this.putDlqAlarm = new Alarm(this, "putDlqAlarm", {
      threshold: 2,
      evaluationPeriods: 2,
      treatMissingData: TreatMissingData.IGNORE,
      metric: this.putSqsDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(2),
        statistic: Stats.MAXIMUM,
        visible: true,
      }),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "There are more than 2 messages in the put sqs dlq",
    });

    this.deleteDlqAlarm = new Alarm(this, "deleteDlqAlarm", {
      threshold: 2,
      evaluationPeriods: 2,
      treatMissingData: TreatMissingData.IGNORE,
      metric: this.deleteSqsDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(2),
        statistic: Stats.MAXIMUM,
        visible: true,
      }),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "There are more than 2 messages in the delete sqs dlq",
    });

    this.putQueueDepthAlarm = new Alarm(this, "putQueueDepthAlarm", {
      threshold: 20,
      evaluationPeriods: 1,
      metric: this.putEventsSqsQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(2),
        statistic: Stats.AVERAGE,
      }),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Put queue has too many messages, processing is too slow",
    });

    this.deleteQueueDepthAlarm = new Alarm(this, "deleteQueueDepthAlarm", {
      threshold: 20,
      evaluationPeriods: 1,
      metric:
        this.deleteEventsSqsQueue.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(2),
          statistic: Stats.AVERAGE,
        }),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription:
        "Delete queue has too many messages, processing is too slow",
    });

    [
      this.putDlqAlarm,
      this.deleteDlqAlarm,
      this.lambdaProcessingTimeAlarm,
      this.putQueueDepthAlarm,
      this.deleteQueueDepthAlarm,
    ].forEach((alarm) =>
      alarm.addAlarmAction(new SnsAction(this.notificationTopic)),
    );

    //used to verify signed urls/cookies
    const publicKey = new cloudfront.PublicKey(this, "AssetsPublicKey", {
      encodedKey: props.cloudfrontPublicKey,
    });

    const keyGroup = new cloudfront.KeyGroup(this, "AssetsKeyGroup", {
      items: [publicKey],
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "AssetsCertificate",
      props.cloudfrontDomainCertificateArn,
    );

    const distribution = new cloudfront.Distribution(
      this,
      "AssetsDistribution",
      {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.s3Bucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          trustedKeyGroups: [keyGroup],
        },
        domainNames: [props.cloudfrontDomainName],
        priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
        certificate: certificate,
        comment: "Distribution for files the user uploaded",
      },
    );

    new CfnOutput(this, "DistributionDomain", {
      value: distribution.distributionDomainName,
    });

    new CfnOutput(this, "PublicKeyId", {
      value: publicKey.publicKeyId,
    });

    new CfnOutput(this, "applicationUsername", {
      value: this.applicationUser.userName,
      exportName: "applicationUsername",
      description: "IAM username for NestJS application",
    });

    new CfnOutput(this, "S3BucketName", {
      value: this.s3Bucket.bucketName,
      exportName: "S3BucketName",
      description: "S3 Bucket name for file uploads",
    });

    new CfnOutput(this, "userRequestedDeleteQueueUrl", {
      value: this.userRequestedDeleteQueue.queueUrl,
      exportName: "userRequestedDeleteQueueUrl",
      description: "SQS Url for sending delete requests",
    });

    NagSuppressions.addResourceSuppressions(this.webhookSignatureSecret, [
      {
        id: "AwsSolutions-SMG4",
        reason:
          "Rotation is not required for this webhook secret because it is static and managed externally.",
      },
    ]);

    NagSuppressions.addResourceSuppressions(distribution, [
      {
        id: "AwsSolutions-CFR3",
        reason:
          "CloudFront access logging not required, S3 server access logs provide sufficient audit trail",
      },
    ]);

    [
      this.infectedFilesDeleteLambda,
      this.validateUploadedFilesLambda,
      this.removeDeletedFilesLambda,
      this.userRequestedDeleteLambda,
    ].forEach((lambda) => {
      NagSuppressions.addResourceSuppressions(
        lambda,
        [
          {
            id: "AwsSolutions-IAM4",
            reason:
              "AWSLambdaBasicExecutionRole is intentionally used for standard Lambda CloudWatch logging",
            appliesTo: [
              "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
            ],
          },
          {
            id: "AwsSolutions-IAM5",
            reason:
              "wildcard actions are generated by CDK grant methods & are scoped to the specific S3 bucket",
            appliesTo: [
              "Action::s3:GetObject*",
              "Action::s3:GetBucket*",
              "Action::s3:List*",
              "Action::s3:Abort*",
              "Action::s3:DeleteObject*",
              "Resource::<TempInfraResourcestempS3Bucket668A5B7B.Arn>/*",
            ],
          },
        ],
        true,
      );
    });

    NagSuppressions.addResourceSuppressions(
      this.applicationUser,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "wildcard actions are generated by CDK grant methods & are scoped to the specific S3 bucket",
          appliesTo: [
            "Action::s3:GetObject*",
            "Action::s3:GetBucket*",
            "Action::s3:List*",
            "Action::s3:Abort*",
            "Resource::<TempInfraResourcestempS3Bucket668A5B7B.Arn>/*",
          ],
        },
      ],
      true,
    );

    cdk.Aspects.of(this).add(
      new AwsSolutionsChecks({
        verbose: true,
      }),
    );
  }
}

export class TempStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: TempConstructProps & cdk.StackProps,
  ) {
    super(scope, id, props);

    new TempInfraConstruct(this, "TempInfraResources", {
      frontendDomainUrl: props.frontendDomainUrl,
      backendWebhookUrl: props.backendWebhookUrl,
      notificationEmail: props.notificationEmail,
      cloudfrontPublicKey: props.cloudfrontPublicKey,
      cloudfrontDomainName: props.cloudfrontDomainName,
      cloudfrontDomainCertificateArn: props.cloudfrontDomainCertificateArn,
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "BucketNotificationsHandler is a CDK internal lambda and cannot be modified",
        appliesTo: [
          "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      },
    ]);

    cdk.Aspects.of(this).add(
      new AwsSolutionsChecks({
        verbose: true,
      }),
    );
  }
}
