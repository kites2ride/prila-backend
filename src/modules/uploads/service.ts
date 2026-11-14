import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

function r2Configured(): boolean {
  const e = env();
  return Boolean(e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET);
}

function client(): S3Client {
  const e = env();
  return new S3Client({
    region: 'auto',
    endpoint: `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: e.R2_ACCESS_KEY_ID,
      secretAccessKey: e.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function createPresignedUpload(input: {
  folder: string;
  contentType: string;
  extension?: string;
}) {
  if (!r2Configured()) {
    throw new AppError('UPLOADS_DISABLED', 'R2 is not configured', 503);
  }
  const e = env();
  const ext = input.extension ? input.extension.replace(/^\./, '') : 'bin';
  const key = `${input.folder.replace(/\/$/, '')}/${randomUUID()}.${ext}`;
  const command = new PutObjectCommand({
    Bucket: e.R2_BUCKET,
    Key: key,
    ContentType: input.contentType,
  });
  const uploadUrl = await getSignedUrl(client(), command, { expiresIn: 600 });
  const publicUrl = e.R2_PUBLIC_BASE_URL
    ? `${e.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
    : key;
  return { uploadUrl, publicUrl, key, expiresInSec: 600 };
}
