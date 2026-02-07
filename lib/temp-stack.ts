import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  Runtime,
  DockerImageCode,
  DockerImageFunction,
} from "aws-cdk-lib/aws-lambda";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Topic } from "aws-cdk-lib/aws-sns";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { User } from "aws-cdk-lib/aws-iam";
import { CfnOutput } from "aws-cdk-lib/core";

interface TempConstructProps {
  notificationEmail: string;
}

class TempInfraConstruct extends Construct {
  public readonly s3Bucket: Bucket;
  public readonly putEventsSqsQueue: Queue;
  public readonly putSqsDlq: Queue;
  public readonly deleteEventsSqsQueue: Queue;
  public readonly deleteSqsDlq: Queue;
  public readonly putEventsLambda: NodejsFunction;
  public readonly deleteEventsLambda: NodejsFunction;
  public readonly validateUploadedFilesLambda: NodejsFunction;
  public readonly removeDeletedFilesLambda: NodejsFunction;

  private readonly applicationUser: User;
  private readonly webhookApiKeySecret: Secret;

  constructor(scope: Construct, id: string, props: TempConstructProps) {
    super(scope, id);

    this.applicationUser = new User(this, "applicationUser");

    this.webhookApiKeySecret = new Secret(this, "webhookApiKeySecret", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      description: "Secret for webhook authentication",
      generateSecretString: {
        passwordLength: 32,
        includeSpace: false,
        generateStringKey: "apiKey",
        secretStringTemplate: JSON.stringify({
          apiKey: "",
        }),
      },
    });

    this.s3Bucket = new Bucket(this, "tempS3Bucket", {
      enforceSSL: true,
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
      ],
    });

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

    this.putEventsLambda = new NodejsFunction(this, "putEventsLambda", {
      runtime: Runtime.NODEJS_24_X,
      description:
        "This is responsible for receiving s3 put events and pushing it to the put sqs queue",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      handler: "index.handler",
      entry: "./workers/handlePutEvents.ts",
      retryAttempts: 2,
      environment: {
        SQS_QUEUE_URL: this.putEventsSqsQueue.queueUrl,
      },
    });

    this.deleteEventsLambda = new NodejsFunction(this, "deleteEventsLambda", {
      runtime: Runtime.NODEJS_24_X,
      description:
        "This is responsible for receiving s3 delete events and pushing it to the delete sqs queue",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      retryAttempts: 2,
      handler: "index.handler",
      entry: "./workers/handleDeleteEvents.ts",
      environment: {
        SQS_QUEUE_URL: this.deleteEventsSqsQueue.queueUrl,
      },
    });

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
          WEBHOOK_SECRET_ARN: this.webhookApiKeySecret.secretArn,
        },
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
          WEBHOOK_SECRET_ARN: this.webhookApiKeySecret.secretArn,
        },
      },
    );

    this.validateUploadedFilesLambda.addEventSource(
      new SqsEventSource(this.putEventsSqsQueue, {
        batchSize: 5,
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

    this.putEventsSqsQueue.grantSendMessages(this.putEventsLambda);
    this.deleteEventsSqsQueue.grantSendMessages(this.deleteEventsLambda);

    this.putEventsSqsQueue.grantConsumeMessages(
      this.validateUploadedFilesLambda,
    );
    this.deleteEventsSqsQueue.grantConsumeMessages(
      this.removeDeletedFilesLambda,
    );

    this.s3Bucket.addEventNotification(
      EventType.OBJECT_CREATED_PUT,
      new LambdaDestination(this.putEventsLambda),
    );

    this.s3Bucket.addEventNotification(
      EventType.OBJECT_REMOVED_DELETE,
      new LambdaDestination(this.deleteEventsLambda),
    );

    this.s3Bucket.grantPut(this.applicationUser);
    this.s3Bucket.grantRead(this.applicationUser);
    this.s3Bucket.grantRead(this.validateUploadedFilesLambda);

    this.webhookApiKeySecret.grantRead(this.removeDeletedFilesLambda);
    this.webhookApiKeySecret.grantRead(this.validateUploadedFilesLambda);

    //observability stuff
    const notificationTopic = new Topic(this, "notificationTopic", {
      enforceSSL: true,
      displayName: "File Processing Service Alerts",
    });

    notificationTopic.addSubscription(
      new EmailSubscription(props.notificationEmail),
    );

    const lambdaProcessingTimeAlarm = new Alarm(
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

    const putDlqAlarm = new Alarm(this, "putDlqAlarm", {
      threshold: 2,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.IGNORE,
      metric: this.putSqsDlq.metricApproximateNumberOfMessagesVisible(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "There are more than 2 messages in the put sqs dlq",
    });

    const deleteDlqAlarm = new Alarm(this, "deleteDlqAlarm", {
      threshold: 2,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.IGNORE,
      metric: this.deleteSqsDlq.metricApproximateNumberOfMessagesVisible(),
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      alarmDescription: "There are more than 2 messages in the delete sqs dlq",
    });

    putDlqAlarm.addAlarmAction(new SnsAction(notificationTopic));
    deleteDlqAlarm.addAlarmAction(new SnsAction(notificationTopic));
    lambdaProcessingTimeAlarm.addAlarmAction(new SnsAction(notificationTopic));

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
      notificationEmail: props.notificationEmail,
    });
  }
}
