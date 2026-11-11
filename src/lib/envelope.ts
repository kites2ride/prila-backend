export type OkEnvelope<T> = { ok: true; data: T };
export type ErrEnvelope = { ok: false; error: { code: string; message: string; details?: unknown } };

export function ok<T>(data: T): OkEnvelope<T> {
  return { ok: true, data };
}

export function fail(code: string, message: string, details?: unknown): ErrEnvelope {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}
