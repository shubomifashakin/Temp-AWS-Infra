import { spawn } from "child_process";
import { createHmac } from "crypto";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  AutoScalingClient,
  CompleteLifecycleActionCommand,
  RecordLifecycleActionHeartbeatCommand,
} from "@aws-sdk/client-auto-scaling";
import { MetadataService } from "@aws-sdk/ec2-metadata-service";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const MULTIPART_QUEUE_URL = requireEnv("MULTIPART_QUEUE_URL");
const INFECTED_QUEUE_URL = requireEnv("INFECTED_QUEUE_URL");
const WEBHOOK_URL = requireEnv("WEBHOOK_URL");
const WEBHOOK_SECRET_ARN = requireEnv("WEBHOOK_SECRET_ARN");
const CLOUDFLARE_BYPASS_SECRET = requireEnv("CLOUDFLARE_BYPASS_SECRET");
const LIFECYCLE_HOOK_NAME = requireEnv("SCANNER_TERMINATION_HOOK_NAME");
const CLAMAV_BIN = process.env.CLAMAV_BIN ?? "/usr/bin/clamscan";
const CLAMAV_DB_PATH = process.env.CLAMAV_DB_PATH ?? "/var/lib/clamav";

// ---- Types ----
interface ScanResult {
  infected: boolean;
  virus?: string;
}

type FnResult<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: Error };

interface S3EventRecord {
  s3: {
    bucket: { name: string };
    object: { key: string };
  };
}

interface S3EventNotification {
  Records: S3EventRecord[];
}

let s3: S3Client;
let sqs: SQSClient;
let secrets: SecretsManagerClient;
let asg: AutoScalingClient;
let metadataCl = new MetadataService({
  endpoint: "http://169.254.169.254",
  httpOptions: { timeout: 10_000 },
});

async function getMetadata(path: string): Promise<string> {
  return metadataCl.request(`/latest/meta-data/${path}`, { method: "GET" });
}

async function metadataExists(path: string): Promise<boolean> {
  try {
    const data = await metadataCl.request(`/latest/meta-data/${path}`, {
      method: "GET",
    });

    if (!data || data === "") return false;
    const timestamp = Date.parse(data);
    return !isNaN(timestamp);
  } catch {
    return false;
  }
}

async function initClients(): Promise<void> {
  const region = await getMetadata("placement/region");
  s3 = new S3Client({ region });
  sqs = new SQSClient({ region });
  secrets = new SecretsManagerClient({ region });
  asg = new AutoScalingClient({ region });
  console.log(`AWS clients initialised in ${region}`);
}

// ---- Cached lookups ----
let cachedInstanceId: string;
let cachedAsgName: string;
let cachedWebhookSecret: string;

async function getInstanceId(): Promise<string> {
  if (cachedInstanceId) return cachedInstanceId;
  cachedInstanceId = await getMetadata("instance-id");
  return cachedInstanceId;
}

async function getAsgName(): Promise<string> {
  if (cachedAsgName) return cachedAsgName;
  cachedAsgName = await getMetadata("tags/instance/aws:autoscaling:groupName");
  return cachedAsgName;
}

async function getWebhookSecret(): Promise<string> {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  const res = await secrets.send(
    new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_ARN }),
  );
  if (!res.SecretString) throw new Error("Webhook secret is empty");
  const parsed = JSON.parse(res.SecretString) as { secret: string };
  cachedWebhookSecret = parsed.secret;
  return cachedWebhookSecret;
}

// ---- ClamAV scanning ----
function scanStream(stream: NodeJS.ReadableStream): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const clamscan = spawn(CLAMAV_BIN, [
      "--no-summary",
      "--max-filesize=0", // no limit — file is streamed, not loaded into memory
      "--max-scansize=0", // no limit on data scanned
      `--database=${CLAMAV_DB_PATH}`,
      "-", // read from stdin
    ]);

    stream.pipe(clamscan.stdin);

    let stdout = "";
    let stderr = "";

    clamscan.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    clamscan.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    clamscan.on("close", (code: number | null) => {
      console.log(`ClamAV exit ${code}: ${stdout.trim()}`);
      if (code === 0) {
        resolve({ infected: false });
      } else if (code === 1) {
        const match = stdout.match(/stdin:\s*(.+?)\s+FOUND/);
        resolve({ infected: true, virus: match?.[1]?.trim() ?? "Unknown" });
      } else {
        reject(new Error(`ClamAV error (code ${code}): ${stderr.trim()}`));
      }
    });

    clamscan.on("error", (err: Error) =>
      reject(new Error(`Failed to start ClamAV: ${err.message}`)),
    );

    stream.on("error", (err: Error) => {
      clamscan.stdin.destroy();
      reject(err);
    });
  });
}

// ---- Process a single S3 event record ----
async function processRecord(
  record: S3EventRecord,
  webhookSecret: string,
): Promise<FnResult<ScanResult>> {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  console.log(`Processing s3://${bucket}/${key}`);

  try {
    const s3Res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!s3Res.Body) throw new Error("Empty S3 body");

    const scanResult = await scanStream(s3Res.Body as NodeJS.ReadableStream);
    console.log(`Scan complete: infected=${scanResult.infected} (${key})`);

    if (scanResult.infected) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: INFECTED_QUEUE_URL,
          MessageBody: JSON.stringify({ s3Key: key }),
        }),
      );
      console.log(`Queued infected file for deletion: ${key}`);
    }

    const body = JSON.stringify({
      type: "file:validated",
      timestamp: new Date(),
      data: { key, infected: scanResult.infected },
    });

    const signature = createHmac("sha256", webhookSecret)
      .update(body)
      .digest("hex");

    const webhookRes = await fetch(WEBHOOK_URL, {
      method: "POST",
      body,
      headers: {
        "x-signature": signature,
        "Content-Type": "application/json",
        "x-internal-token": CLOUDFLARE_BYPASS_SECRET,
      },
    });

    if (!webhookRes.ok) {
      throw new Error(`Webhook HTTP ${webhookRes.status}`);
    }

    return { success: true, data: scanResult, error: null };
  } catch (error) {
    console.error(`Error processing ${key}:`, error);
    return { success: false, data: null, error: error as Error };
  }
}

// ---- SQS polling ----
async function pollOnce(webhookSecret: string): Promise<void> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: MULTIPART_QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
    }),
  );

  const messages = res.Messages ?? [];
  if (!messages.length) return;

  for (const message of messages) {
    if (!message.Body || !message.ReceiptHandle) continue;

    const notification = JSON.parse(message.Body) as S3EventNotification;
    let allSucceeded = true;

    for (const record of notification.Records) {
      const result = await processRecord(record, webhookSecret);
      if (!result.success) allSucceeded = false;
    }

    if (allSucceeded) {
      await sqs.send(
        new DeleteMessageCommand({
          QueueUrl: MULTIPART_QUEUE_URL,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
    // On failure: message stays in queue until visibility timeout expires,
    // then retries up to maxReceiveCount before landing in the DLQ.
  }
}

// ---- ASG lifecycle hook ----
async function completeLifecycle(): Promise<void> {
  const [instanceId, asgName] = await Promise.all([
    getInstanceId(),
    getAsgName(),
  ]);
  console.log(`Completing lifecycle hook for ${instanceId} in ${asgName}`);
  await asg.send(
    new CompleteLifecycleActionCommand({
      AutoScalingGroupName: asgName,
      LifecycleHookName: LIFECYCLE_HOOK_NAME,
      LifecycleActionResult: "CONTINUE",
      InstanceId: instanceId,
    }),
  );
  console.log("Lifecycle action completed");
}

async function sendHeartbeat(): Promise<void> {
  try {
    const [instanceId, asgName] = await Promise.all([
      getInstanceId(),
      getAsgName(),
    ]);
    await asg.send(
      new RecordLifecycleActionHeartbeatCommand({
        AutoScalingGroupName: asgName,
        LifecycleHookName: LIFECYCLE_HOOK_NAME,
        InstanceId: instanceId,
      }),
    );
    console.log("Lifecycle heartbeat sent");
  } catch (err) {
    console.warn("Heartbeat skipped (hook may not be active yet):", err);
  }
}

// ---- Termination detection ----
async function isTerminating(): Promise<boolean> {
  try {
    const state = await getMetadata("autoscaling/target-lifecycle-state");
    return state.trim() === "Terminated";
  } catch {
    return false;
  }
}

async function isSpotInterrupted(): Promise<boolean> {
  return metadataExists("spot/termination-time");
}

async function main(): Promise<void> {
  console.log("Large file scanner starting");
  await initClients();

  const webhookSecret = await getWebhookSecret();
  let shuttingDown = false;

  const terminationTimer = setInterval(() => {
    void Promise.all([isTerminating(), isSpotInterrupted()]).then(
      ([terminating, spotInterrupted]) => {
        if (terminating || spotInterrupted) {
          console.log(
            `Shutdown signal (ASG=${terminating}, spot=${spotInterrupted})`,
          );
          shuttingDown = true;
        }
      },
    );
  }, 10_000);

  const heartbeatTimer = setInterval(
    () => void sendHeartbeat(),
    15 * 60 * 1000,
  );

  console.log("Polling SQS for multipart upload events");

  while (!shuttingDown) {
    try {
      await pollOnce(webhookSecret);
    } catch (err) {
      console.error("Poll error:", err);
      await new Promise<void>((r) => setTimeout(r, 10_000));
    }
  }

  clearInterval(terminationTimer);
  clearInterval(heartbeatTimer);

  console.log("Graceful shutdown: completing lifecycle action");
  await completeLifecycle();

  console.log("Scanner stopped cleanly");
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
