import { SQSEvent } from "aws-lambda";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const awsRegion = process.env.AWS_REGION;
const webhookSecretArn = process.env.WEBHOOK_SECRET_ARN!;

const secretsManagerClient = new SecretsManagerClient({ region: awsRegion });

export async function handler(event: SQSEvent) {
  const keys = event.Records.map((record) => JSON.parse(record.body)) as {
    key: string;
  }[];

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

  //FIXME: use corrrect webhook endpoint
  const response = await fetch(
    "https://dev-api-temp.545plea.xyz/api/v1/webhooks/files",
    {
      method: "POST",
      body: JSON.stringify({
        data: { keys: keys.map((key) => key.key), deletedAt: new Date() },
        type: "file:deleted",
      }),
      headers: {
        "x-signature": signature,
        "Content-Type": "application/json",
      },
    },
  );

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
