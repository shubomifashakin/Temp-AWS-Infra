import { SQSEvent } from "aws-lambda";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { spawn } from "child_process";
import { createWriteStream, unlinkSync } from "fs";
import { pipeline } from "stream/promises";

export interface PutFileRecord {
  key: string;
  bucket: string;
  eventType: string;
}

const AWS_REGION = process.env.AWS_REGION;

const s3Client = new S3Client({ region: AWS_REGION });
const CLAMAV_DB_PATH = "/var/lib/clamav";

interface ScanResult {
  infected: boolean;
  virus?: string;
}

type FnResult<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: Error };

export const handler = async (
  event: SQSEvent,
): Promise<{
  batchItemFailures: { itemIdentifier: string }[];
}> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const body = JSON.parse(record.body) as PutFileRecord;

    const result = await processRecord(body);

    if (!result.success) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return {
    batchItemFailures,
  };
};

async function processRecord(
  record: PutFileRecord,
): Promise<FnResult<ScanResult>> {
  const bucket = record.bucket;
  const key = decodeURIComponent(record.key.replace(/\+/g, " "));

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

    // FIXME: send the status to the API
    // const response = await fetch("https://temp.545plea.xyz/api", {
    //   method: "POST",
    //   body: JSON.stringify({ status: scanResult.infected, fileName: key }),
    //   headers: {
    //     "Content-Type": "application/json",
    //     "X-API-Key": "your-api-key-here", //
    //   },
    // });

    // if (!response.ok) {
    //   console.error(`Failed to send result for ${key}:`, response.statusText);

    //   throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    // }

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
    try {
      unlinkSync(localPath);
    } catch (e) {
      console.log(`Failed to delete ${localPath}:`, e);
    }
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
        // Clean file
        resolve({ infected: false });
      } else if (code === 1) {
        // Infected file - parse virus name
        const virusMatch = stdout.match(/:\s*(.+?)\s+FOUND/);
        const virusName = virusMatch ? virusMatch[1].trim() : "Unknown";
        resolve({
          infected: true,
          virus: virusName,
        });
      } else {
        // Error
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
