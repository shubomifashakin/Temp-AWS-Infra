import { SQSEvent } from "aws-lambda";
import { DeleteObjectsCommand, S3Client } from "@aws-sdk/client-s3";

const awsRegion = process.env.AWS_REGION;
const bucketName = process.env.BUCKET_NAME;

const s3Client = new S3Client({
  region: awsRegion,
});

type MessageBody = {
  userId: string;
  fileId: string;
};

export async function handler(event: SQSEvent) {
  if (!bucketName) {
    throw new Error("BUCKET_NAME environment variable is not set");
  }

  const batchItemFailures: { itemIdentifier: string }[] = [];

  const records: { messageId: string; body: MessageBody }[] = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as MessageBody;
      records.push({ body, messageId: record.messageId });
    } catch (error) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  if (records.length === 0) {
    return { batchItemFailures };
  }

  try {
    const response = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName,
        Delete: {
          Objects: records.map((c) => {
            return { Key: c.body.fileId };
          }),
        },
      }),
    );

    if (response.Errors?.length) {
      for (const error of response.Errors) {
        const failedRecord = records.find(
          (record) => record.body.fileId === error.Key,
        );

        if (failedRecord) {
          batchItemFailures.push({ itemIdentifier: failedRecord.messageId });
        }
      }
    }
  } catch (error) {
    for (const record of records) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return {
    batchItemFailures,
  };
}
