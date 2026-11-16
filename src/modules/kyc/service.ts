import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { AdminAuditLog, City } from '../app/model.js';
import { getConfigValue } from '../app/service.js';
import { Pilot } from '../auth/model.js';
import { signedGetUrl } from '../uploads/service.js';

type DocDef = { id: string; label: string; required: boolean };
type VehicleType = 'bike' | 'auto' | 'parcel' | 'logistics';

/** Server-driven list of documents per vehicle (admin → App config → kycDocumentsByVehicle). */
export async function requiredDocs(vehicleType: string): Promise<DocDef[]> {
  const cfg = (await getConfigValue('app_config_pilot')) as { kycDocumentsByVehicle?: Record<string, DocDef[]> } | undefined;
  return cfg?.kycDocumentsByVehicle?.[vehicleType] ?? [];
}

/** Indian registration numbers, spaces / dashes removed: TS03AB1234, TS03A1234, 22BH1234AA. */
export function normalizeVehicleNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
const VEHICLE_NO = /^([A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}|\d{2}BH\d{4}[A-Z]{1,2})$/;

function assertObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
}

async function notifyPilot(pilotId: string, title: string, body: string) {
  try {
    const { pushToUser } = await import('../push/devices.js');
    const { createInboxNotification } = await import('../push/inbox.js');
    const data = { deepLink: 'prilapilot://kyc' };
    await pushToUser('pilot', pilotId, title, body, data);
    await createInboxNotification({ userId: pilotId, typ: 'pilot', title, body, data });
  } catch {
    /* push is best-effort */
  }
}

/* ───────────────────────── pilot side ───────────────────────── */

export async function submit(
  pilotId: string,
  body: { name: string; vehicleType: VehicleType; vehicleNumber: string; documents: Record<string, string> },
) {
  const pilot = await Pilot.findById(pilotId);
  if (!pilot) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  if (pilot.kycStatus === 'pending') throw new AppError('KYC_PENDING', 'Your documents are already under review', 409);
  if (pilot.kycStatus === 'approved') throw new AppError('KYC_APPROVED', 'Your documents are already approved', 409);

  const vehicleNumber = normalizeVehicleNumber(body.vehicleNumber);
  if (!VEHICLE_NO.test(vehicleNumber)) {
    throw new AppError('VALIDATION_ERROR', 'Enter the vehicle number as on the RC, e.g. TS03AB1234', 400);
  }

  const defs = await requiredDocs(body.vehicleType);
  const known = new Set(defs.map((d) => d.id));

  const prefix = `kyc/${pilotId}/`;
  const docs: Array<{ docId: string; key: string; uploadedAt: Date }> = [];
  for (const [docId, key] of Object.entries(body.documents)) {
    if (!known.has(docId)) throw new AppError('VALIDATION_ERROR', `Unknown document ${docId}`, 400);
    // Only files this pilot uploaded through /uploads/presign (blocks pointing at someone else's file).
    if (!key.startsWith(prefix) || key.includes('..')) {
      throw new AppError('VALIDATION_ERROR', 'Please upload the document again', 400);
    }
    docs.push({ docId, key, uploadedAt: new Date() });
  }

  // Re-applying after a rejection: keep the documents the admin did not mark as wrong,
  // so the pilot only re-uploads the wrong ones (works after a reinstall too).
  if (pilot.kycStatus === 'rejected') {
    const wrong = new Set(pilot.kycRejectedDocs ?? []);
    for (const old of pilot.kycDocs ?? []) {
      if (known.has(old.docId) && !wrong.has(old.docId) && !docs.some((d) => d.docId === old.docId)) {
        docs.push({ docId: old.docId, key: old.key, uploadedAt: old.uploadedAt ?? new Date() });
      }
    }
  }

  const missing = defs.filter((d) => d.required && !docs.some((k) => k.docId === d.id)).map((d) => d.label);
  if (missing.length) throw new AppError('KYC_DOCS_MISSING', `Please upload: ${missing.join(', ')}`, 400);

  const updated = await Pilot.findOneAndUpdate(
    { _id: pilotId, kycStatus: { $in: ['not_started', 'rejected'] } },
    {
      $set: {
        name: body.name.trim(),
        vehicleType: body.vehicleType,
        vehicleNumber,
        kycDocs: docs,
        kycStatus: 'pending',
        kycSubmittedAt: new Date(),
        kycRejectReason: null,
        kycRejectedDocs: [],
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('KYC_PENDING', 'Your documents are already under review', 409);
  return status(pilotId);
}

export async function status(pilotId: string) {
  const p = await Pilot.findById(pilotId).lean();
  if (!p) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  return {
    status: p.kycStatus ?? 'not_started',
    rejectReason: p.kycStatus === 'rejected' ? (p.kycRejectReason ?? null) : null,
    rejectedDocs: p.kycStatus === 'rejected' ? (p.kycRejectedDocs ?? []) : [],
    submittedAt: p.kycSubmittedAt ?? null,
    reviewedAt: p.kycReviewedAt ?? null,
    name: p.name ?? null,
    vehicleType: p.vehicleType ?? null,
    vehicleNumber: p.vehicleNumber ?? null,
    uploadedDocs: (p.kycDocs ?? []).map((d) => d.docId),
  };
}

/* ───────────────────────── admin side ───────────────────────── */

/** Cheap call for the admin menu badge (polled every 30 s). */
export async function pendingCount() {
  const [count, oldest] = await Promise.all([
    Pilot.countDocuments({ kycStatus: 'pending' }),
    Pilot.findOne({ kycStatus: 'pending' }).sort({ kycSubmittedAt: 1 }).select('kycSubmittedAt name vehicleType').lean(),
  ]);
  const newest = count
    ? await Pilot.findOne({ kycStatus: 'pending' }).sort({ kycSubmittedAt: -1 }).select('_id name vehicleType kycSubmittedAt').lean()
    : null;
  return {
    pending: count,
    oldestSubmittedAt: oldest?.kycSubmittedAt ?? null,
    newest: newest
      ? { id: String(newest._id), name: newest.name ?? null, vehicleType: newest.vehicleType ?? null, submittedAt: newest.kycSubmittedAt ?? null }
      : null,
  };
}

export async function list(kycStatus: 'pending' | 'approved' | 'rejected', page: number, limit: number) {
  const filter = { kycStatus };
  const sort: Record<string, 1 | -1> = kycStatus === 'pending' ? { kycSubmittedAt: 1 } : { kycReviewedAt: -1 };
  const [rows, total] = await Promise.all([
    Pilot.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .select('name phone vehicleType vehicleNumber cityId kycSubmittedAt kycReviewedAt kycReviewedBy kycRejectReason')
      .lean(),
    Pilot.countDocuments(filter),
  ]);
  return {
    items: rows.map((p) => ({
      id: String(p._id),
      name: p.name ?? null,
      phone: p.phone,
      vehicleType: p.vehicleType ?? null,
      vehicleNumber: p.vehicleNumber ?? null,
      submittedAt: p.kycSubmittedAt ?? null,
      reviewedAt: p.kycReviewedAt ?? null,
      reviewedBy: p.kycReviewedBy ?? null,
      rejectReason: p.kycRejectReason ?? null,
    })),
    page,
    limit,
    total,
  };
}

export async function detail(pilotId: string) {
  assertObjectId(pilotId);
  const p = await Pilot.findById(pilotId).lean();
  if (!p) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  const defs = await requiredDocs(p.vehicleType ?? 'bike');
  const label = new Map(defs.map((d) => [d.id, d.label]));
  const city = p.cityId ? await City.findById(p.cityId).select('name').lean() : null;
  const docs = await Promise.all(
    (p.kycDocs ?? []).map(async (d) => ({
      docId: d.docId,
      label: label.get(d.docId) ?? d.docId,
      isPdf: d.key.toLowerCase().endsWith('.pdf'),
      url: await signedGetUrl(d.key, 300), // 5-minute link; reopen the page for a fresh one
      uploadedAt: d.uploadedAt ?? null,
    })),
  );
  return {
    id: String(p._id),
    name: p.name ?? null,
    phone: p.phone,
    city: city?.name ?? null,
    vehicleType: p.vehicleType ?? null,
    vehicleNumber: p.vehicleNumber ?? null,
    status: p.kycStatus ?? 'not_started',
    submittedAt: p.kycSubmittedAt ?? null,
    reviewedAt: p.kycReviewedAt ?? null,
    reviewedBy: p.kycReviewedBy ?? null,
    rejectReason: p.kycRejectReason ?? null,
    rejectedDocs: p.kycRejectedDocs ?? [],
    documents: docs,
    missingRequired: defs.filter((d) => d.required && !(p.kycDocs ?? []).some((k) => k.docId === d.id)).map((d) => d.label),
    linksExpireInSec: 300,
  };
}

export async function approve(actor: string, pilotId: string) {
  assertObjectId(pilotId);
  const before = await Pilot.findById(pilotId).lean();
  if (!before) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  const selfie = (before.kycDocs ?? []).find((d) => d.docId === 'selfie');
  const updated = await Pilot.findOneAndUpdate(
    { _id: pilotId, kycStatus: 'pending' },
    {
      $set: {
        kycStatus: 'approved',
        kycReviewedAt: new Date(),
        kycReviewedBy: actor,
        kycRejectReason: null,
        kycRejectedDocs: [],
        ...(selfie ? { photoKey: selfie.key } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('KYC_NOT_PENDING', 'Already reviewed by someone else. Refresh the list.', 409);
  await AdminAuditLog.create({
    actor,
    action: 'kyc.approve',
    key: 'pilot',
    before: { kycStatus: before.kycStatus },
    after: { kycStatus: 'approved' },
    meta: { pilotId },
  });
  void notifyPilot(pilotId, 'Documents approved', 'You can go online and start taking rides.');
  return { id: pilotId, status: 'approved' };
}

export async function reject(actor: string, pilotId: string, reason: string, docIds: string[]) {
  assertObjectId(pilotId);
  const before = await Pilot.findById(pilotId).lean();
  if (!before) throw new AppError('NOT_FOUND', 'Pilot not found', 404);
  const uploaded = new Set((before.kycDocs ?? []).map((d) => d.docId));
  const wrong = [...new Set(docIds)].filter((d) => uploaded.has(d));
  const updated = await Pilot.findOneAndUpdate(
    { _id: pilotId, kycStatus: 'pending' },
    {
      $set: {
        kycStatus: 'rejected',
        kycReviewedAt: new Date(),
        kycReviewedBy: actor,
        kycRejectReason: reason.trim(),
        kycRejectedDocs: wrong,
      },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw new AppError('KYC_NOT_PENDING', 'Already reviewed by someone else. Refresh the list.', 409);
  await AdminAuditLog.create({
    actor,
    action: 'kyc.reject',
    key: 'pilot',
    before: { kycStatus: before.kycStatus },
    after: { kycStatus: 'rejected', reason: reason.trim(), docs: wrong },
    meta: { pilotId },
  });
  void notifyPilot(pilotId, 'Documents rejected', `Reason: ${reason.trim()}`);
  return { id: pilotId, status: 'rejected' };
}
