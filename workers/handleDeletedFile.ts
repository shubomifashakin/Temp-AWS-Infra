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
    eventType: string;
  }[];

  const secret = await secretsManagerClient.send(
    new GetSecretValueCommand({
      SecretId: webhookSecretArn,
    }),
  );

  if (!secret.SecretString) {
    throw new Error("Secret string is empty");
  }

  const { apiKey } = JSON.parse(secret.SecretString) as {
    apiKey: string;
  };

  //FIXME: make a delete call to our webhook
  const response = await fetch(
    "https://api-temp.545plea.xyz/api/v1/webhook/file-events",
    {
      method: "POST",
      body: JSON.stringify({
        data: keys,
        eventType: "file:deleted",
      }),
      headers: {
        "x-api-key": apiKey,
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
