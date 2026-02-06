import { S3Event } from "aws-lambda";
import { EventType } from "aws-cdk-lib/aws-s3";
import { SendMessageBatchCommand, SQSClient } from "@aws-sdk/client-sqs";

import { v4 as uuid } from "uuid";

const region = process.env.AWS_REGION!;
const SQS_ARN = process.env.SQS_QUEUE_ARN!;

const sqsClient = new SQSClient({ region });

async function sendBatchWithRetry(
  keys: string[],
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const sendMessageCommand = new SendMessageBatchCommand({
      QueueUrl: SQS_ARN,
      Entries: keys.map((key) => ({
        Id: uuid(),
        MessageBody: JSON.stringify({
          key,
          eventType: EventType.OBJECT_REMOVED_DELETE,
        }),
      })),
    });

    const response = await sqsClient.send(sendMessageCommand);

    if (!response.Failed?.length) return;

    if (attempt === maxRetries - 1) {
      throw new Error(
        `Failed to send ${response.Failed.length} messages after ${maxRetries} attempts`,
      );
    }

    const failedKeys = response.Failed.map((failed) => failed.Id);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    keys = keys.filter((key) => failedKeys.includes(key));
  }
}

export async function handler(event: S3Event) {
  const allKeys = event.Records.map((record) => record.s3.object.key);

  await sendBatchWithRetry(allKeys, 4);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Files batched successfully" }),
  };
}
