import { SQSEvent } from "aws-lambda";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const awsRegion = process.env.AWS_REGION;
const webhookUrl = process.env.WEBHOOK_URL!;
const webhookSecretArn = process.env.WEBHOOK_SECRET_ARN!;

const secretsManagerClient = new SecretsManagerClient({ region: awsRegion });

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
      versionId: string;
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

export async function handler(event: SQSEvent) {
  const keys: string[] = [];

  if (!webhookUrl || !webhookSecretArn) {
    throw new Error(
      "WEBHOOK_URL or WEBHOOK_SECRET_ARN environment variable must be set",
    );
  }

  for (const record of event.Records) {
    const body = JSON.parse(record.body) as S3EventNotification;

    for (const s3Record of body.Records) {
      keys.push(s3Record.s3.object.key);
    }
  }

  const secret = await secretsManagerClient.send(
    new GetSecretValueCommand({
      SecretId: webhookSecretArn,
    }),
  );

  if (!secret.SecretString) {
    throw new Error("Secret string is empty");
  }

  const { signature } = JSON.parse(secret.SecretString) as {
    signature: string;
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    body: JSON.stringify({
      data: {
        keys: keys,
        deletedAt: new Date(),
      },
      type: "file:deleted",
      timestamp: new Date(),
    }),
    headers: {
      "x-signature": signature,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    console.error("Failed to delete files", {
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    });

    throw new Error("Failed to delete files");
  }

  return response.json();
}
