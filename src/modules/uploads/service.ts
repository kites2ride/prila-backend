import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

const KYC_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/**
 * Presigned PUT. KYC uploads are forced into `kyc/<pilotId>/` (private: no public URL is
 * returned, admins view them through short-lived signed GET links). Other folders keep
 * the old behaviour.
 */
export async function createPresignedUpload(
  input: { folder: string; contentType: string; extension?: string },
  user?: { sub: string; typ: string },
) {
  const isKyc = /^kyc(\/|$)/.test(input.folder);
  if (isKyc) {
    if (user?.typ !== 'pilot') throw new AppError('FORBIDDEN', 'Only pilots upload KYC documents', 403);
    if (!KYC_TYPES.has(input.contentType)) {
      throw new AppError('VALIDATION_ERROR', 'Upload a photo (JPG / PNG / WEBP) or a PDF', 400);
    }
  }
  if (!r2Configured()) {
    throw new AppError('UPLOADS_DISABLED', 'R2 is not configured', 503);
  }
  const e = env();
  const rawExt = (input.extension ?? 'bin').replace(/^\./, '').toLowerCase();
  const ext = SAFE_EXT.test(rawExt) ? rawExt : 'bin';
  const folder = isKyc ? `kyc/${user!.sub}` : input.folder.replace(/\/$/, '');
  const key = `${folder}/${randomUUID()}.${ext}`;
  const command = new PutObjectCommand({
    Bucket: e.R2_BUCKET,
    Key: key,
    ContentType: input.contentType,
  });
  const uploadUrl = await getSignedUrl(client(), command, { expiresIn: 600 });
  const publicUrl =
    !isKyc && e.R2_PUBLIC_BASE_URL ? `${e.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}` : isKyc ? null : key;
  return { uploadUrl, publicUrl, key, expiresInSec: 600 };
}

/** Short-lived download link for a private object (KYC documents, pilot photo). */
export async function signedGetUrl(key: string, expiresInSec = 300): Promise<string | null> {
  if (!r2Configured() || !key) return null;
  const command = new GetObjectCommand({ Bucket: env().R2_BUCKET, Key: key });
  return getSignedUrl(client(), command, { expiresIn: expiresInSec });
}
