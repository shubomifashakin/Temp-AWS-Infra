import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
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

class TempInfraConstruct extends Construct {
  public readonly s3Bucket: Bucket;
  public readonly putSqsQueue: Queue;
  public readonly putSqsDlq: Queue;
  public readonly deleteSqsQueue: Queue;
  public readonly deleteSqsDlq: Queue;
  public readonly putLambda: NodejsFunction;
  public readonly deleteLambda: NodejsFunction;
  public readonly validateUploadedFilesLambda: NodejsFunction;
  public readonly removeDeletedFilesLambda: NodejsFunction;

  constructor(scope: Construct, id: string) {
    super(scope, id);

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

    this.putSqsQueue = new Queue(this, "putSqsQueue", {
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retentionPeriod: cdk.Duration.minutes(10),
      visibilityTimeout: cdk.Duration.minutes(3),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.putSqsDlq,
      },
    });

    this.deleteSqsQueue = new Queue(this, "deleteSqsQueue", {
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retentionPeriod: cdk.Duration.minutes(10),
      visibilityTimeout: cdk.Duration.minutes(1.5),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: this.deleteSqsDlq,
      },
    });

    this.putLambda = new NodejsFunction(this, "putLambda", {
      runtime: Runtime.NODEJS_24_X,
      description:
        "This is responsible for receiving s3 put events and pushing it to the put sqs queue",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      handler: "index.handler",
      entry: "./workers/handlePutEvents.ts",
      layers: [], //FIXME: NEEDS CLAMAV LAMBDA LAYER
      retryAttempts: 2,
      environment: {
        SQS_QUEUE_ARN: this.putSqsQueue.queueArn,
      },
    });

    this.deleteLambda = new NodejsFunction(this, "deleteLambda", {
      runtime: Runtime.NODEJS_24_X,
      description:
        "This is responsible for receiving s3 delete events and pushing it to the delete sqs queue",
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      retryAttempts: 2,
      handler: "index.handler",
      entry: "./workers/handleDeleteEvents.ts",
      environment: {
        SQS_QUEUE_ARN: this.deleteSqsQueue.queueArn,
      },
    });

    this.validateUploadedFilesLambda = new NodejsFunction(
      this,
      "validateUploadedFilesLambda",
      {
        runtime: Runtime.NODEJS_24_X,
        handler: "index.handler",
        entry: "./workers/handleValidateFile.ts",
        description:
          "This is responsible for validating the files that were put/uploaded to the s3 bucket & updating the status of the files",
        retryAttempts: 2,
        memorySize: 1024 * 2,
        timeout: cdk.Duration.minutes(2.5),
        ephemeralStorageSize: cdk.Size.gibibytes(2.5),
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
      },
    );

    this.validateUploadedFilesLambda.addEventSource(
      new SqsEventSource(this.putSqsQueue, {
        batchSize: 5,
        reportBatchItemFailures: true,
        maxBatchingWindow: cdk.Duration.seconds(30),
      }),
    );

    this.removeDeletedFilesLambda.addEventSource(
      new SqsEventSource(this.deleteSqsQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
        maxBatchingWindow: cdk.Duration.minutes(1),
      }),
    );

    this.putSqsQueue.grantSendMessages(this.putLambda);
    this.deleteSqsQueue.grantSendMessages(this.deleteLambda);

    this.putSqsQueue.grantConsumeMessages(this.validateUploadedFilesLambda);
    this.deleteSqsQueue.grantConsumeMessages(this.removeDeletedFilesLambda);

    this.s3Bucket.addEventNotification(
      EventType.OBJECT_CREATED_PUT,
      new LambdaDestination(this.putLambda),
    );

    this.s3Bucket.addEventNotification(
      EventType.OBJECT_REMOVED_DELETE,
      new LambdaDestination(this.deleteLambda),
    );

    //observability stuff
    const notificationTopic = new Topic(this, "notificationTopic", {
      enforceSSL: true,
      displayName: "Notification Topic",
    });

    notificationTopic.addSubscription(
      new EmailSubscription(""), //FIXME:
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
        alarmDescription: "File validation time is too long",
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
  }
}

export class TempStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new TempInfraConstruct(this, "TempInfraResources");
  }
}
