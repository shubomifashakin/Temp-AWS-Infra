import { unlink } from "fs/promises";
import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

import { SQSEvent } from "aws-lambda";

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

const awsRegion = process.env.AWS_REGION;
const webhookSecretArn = process.env.WEBHOOK_SECRET_ARN!;
const infectedQueueUrl = process.env.INFECTED_QUEUE_URL!;

const secretsManagerClient = new SecretsManagerClient({ region: awsRegion });

const s3Client = new S3Client({ region: awsRegion });
const sqsClient = new SQSClient({ region: awsRegion });

const CLAMAV_DB_PATH = "/var/lib/clamav";

interface ScanResult {
  infected: boolean;
  virus?: string;
}

type FnResult<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: Error };

type S3EventRecord = {
  eventVersion: string;
  eventSource: string;
  awsRegion: string;
  eventTime: string;
  eventName: string;
  userIdentity: {
    principalId: string;
  };
  requestParameters: {
    sourceIPAddress: string;
  };
  responseElements: {
    "x-amz-request-id": string;
    "x-amz-id-2": string;
  };
  s3: {
    s3SchemaVersion: string;
    configurationId: string;
    bucket: {
      name: string;
      ownerIdentity: {
        principalId: string;
      };
      arn: string;
    };
    object: {
      key: string;
      size: number;
      eTag: string;
      versionId?: string;
      sequencer: string;
    };
  };
  glacierEventData?: {
    restoreEventData: {
      lifecycleRestorationExpiryTime: string;
      lifecycleRestoreStorageClass: string;
    };
  };
};

type S3EventNotification = {
  Records: S3EventRecord[];
};

export const handler = async (
  event: SQSEvent,
): Promise<{
  batchItemFailures: { itemIdentifier: string }[];
}> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  const secret = await secretsManagerClient.send(
    new GetSecretValueCommand({
      SecretId: webhookSecretArn,
    }),
  );

  if (!secret.SecretString) {
    throw new Error("Secret string is empty");
  }

  const parsedSecretsString = JSON.parse(secret.SecretString) as {
    signature: string;
  };

  for (const record of event.Records) {
    const body = JSON.parse(record.body) as S3EventNotification;

    for (const s3Record of body.Records) {
      const result = await processRecord(
        s3Record,
        parsedSecretsString.signature,
      );

      if (!result.success) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
  }

  return {
    batchItemFailures,
  };
};

async function processRecord(
  record: S3EventRecord,
  signature: string,
): Promise<FnResult<ScanResult>> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  console.log(`Scanning ${bucket}/${key}`);

  const localPath = `/tmp/${key.split("/").pop()}`;

  try {
    const downloadResult = await downloadFile(bucket, key, localPath);

    if (!downloadResult.success) {
      console.error(`Failed to download ${key}:`, downloadResult.error);

      throw downloadResult.error;
    }

    const scanResult = await scanFile(localPath);

    console.log("Scan result:", scanResult);

    if (scanResult.infected) {
      console.log("Queuing infected file for removal");

      const sendMessage = new SendMessageCommand({
        QueueUrl: infectedQueueUrl,
        MessageBody: JSON.stringify({
          s3Key: key,
        }),
      });

      await sqsClient.send(sendMessage);

      console.log("infected file queued for removal");
    }

    // FIXME: use correct api
    const response = await fetch(
      "https://dev-api-temp.545plea.xyz/api/v1/webhooks/files",
      {
        method: "POST",
        body: JSON.stringify({
          type: "file:validated",
          data: {
            key,
            infected: scanResult.infected,
          },
        }),
        headers: {
          "x-signature": signature,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      console.error(`Failed to send result for ${key}:`, response.statusText);

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      success: true,
      data: scanResult,
      error: null,
    };
  } catch (error) {
    console.error(`Error processing ${key}:`, error);

    return {
      data: null,
      success: false,
      error: error as Error,
    };
  } finally {
    await unlink(localPath).catch((e) => {
      console.error(`Failed to delete ${localPath}:`, e);
    });
  }
}

async function downloadFile(
  bucket: string,
  key: string,
  localPath: string,
): Promise<FnResult<null>> {
  try {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);

    if (!response.Body) {
      throw new Error("No body in S3 response");
    }

    const writeStream = createWriteStream(localPath);

    await pipeline(response.Body as NodeJS.ReadableStream, writeStream);

    console.log(`Downloaded to ${localPath}`);

    return { success: true, data: null, error: null };
  } catch (error) {
    return { success: false, error: error as Error, data: null };
  }
}

async function scanFile(filePath: string): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    console.log(`Starting ClamAV scan on ${filePath}`);
    console.log(`Using virus database at ${CLAMAV_DB_PATH}`);

    const clamscan = spawn("/usr/local/bin/clamscan", [
      "--no-summary",
      `--database=${CLAMAV_DB_PATH}`,
      filePath,
    ]);
    let stdout = "";
    let stderr = "";

    clamscan.stdout.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      console.log(`ClamAV stdout: ${output}`);
    });

    clamscan.stderr.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      console.log(`ClamAV stderr: ${output}`);
    });

    clamscan.on("close", (code) => {
      console.log(`ClamAV exit code: ${code}`);
      console.log(`ClamAV full output: ${stdout}`);

      if (code === 0) {
        resolve({ infected: false });
      } else if (code === 1) {
        const virusMatch = stdout.match(/:\s*(.+?)\s+FOUND/);
        const virusName = virusMatch ? virusMatch[1].trim() : "Unknown";
        resolve({
          infected: true,
          virus: virusName,
        });
      } else {
        console.error(`ClamAV error output: ${stderr}`);
        reject(new Error(`ClamAV scan failed with code ${code}: ${stderr}`));
      }
    });

    clamscan.on("error", (error) => {
      console.error(`Failed to spawn ClamAV process: ${error}`);
      reject(new Error(`Failed to start ClamAV: ${error.message}`));
    });
  });
}
