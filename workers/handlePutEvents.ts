import { S3Event } from "aws-lambda";
import { EventType } from "aws-cdk-lib/aws-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

import { v4 as uuid } from "uuid";

export interface PutFileRecord {
  key: string;
  bucket: string;
  eventType: string;
}

const region = process.env.AWS_REGION!;
const SQS_URL = process.env.SQS_QUEUE_URL!;

const sqsClient = new SQSClient({ region });

async function sendBatchWithRetry(
  records: PutFileRecord[],
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const sendMessageCommand = new SendMessageBatchCommand({
      QueueUrl: SQS_URL,

      Entries: records.map((record) => ({
        Id: uuid(),
        MessageBody: JSON.stringify({
          key: record.key,
          bucket: record.bucket,
          eventType: record.eventType,
        }),
      })),
    });

    const response = await sqsClient.send(sendMessageCommand);

    if (!response.Failed?.length) return;

    if (attempt === maxRetries - 1) {
      console.error(
        `Failed to send ${response.Failed.length} messages after ${maxRetries} attempts`,
      );

      throw new Error(
        `Failed to send ${response.Failed.length} messages after ${maxRetries} attempts`,
      );
    }

    const failedKeys = response.Failed.map((failed) => failed.Id);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    records = records.filter((record) => failedKeys.includes(record.key));
  }
}

export async function handler(event: S3Event) {
  const records: PutFileRecord[] = event.Records.map((record) => ({
    key: record.s3.object.key,
    bucket: record.s3.bucket.name,
    eventType: EventType.OBJECT_CREATED_PUT,
  }));

  console.log(`Batching ${records.length} put events`);

  await sendBatchWithRetry(records, 4);

  console.log(`Batched ${records.length} put events`);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Files batched successfully" }),
  };
}
