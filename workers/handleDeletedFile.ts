import { SQSEvent } from "aws-lambda";

export async function handler(event: SQSEvent) {
  const keys = event.Records.map((record) => JSON.parse(record.body)) as {
    key: string;
    eventType: string;
  }[];

  //FIXME: make a delete call to our webhook
  const response = await fetch("https://api-temp.545plea.xyz/api/v1/file", {
    method: "POST",
    body: JSON.stringify({
      keys: keys.map((key) => key.key),
      eventType: "file:deleted",
    }),
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to delete files");
  }
  return response.json();
}
