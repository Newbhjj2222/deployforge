/**
 * Application errors carry a stable machine code, an HTTP status and a message that is
 * safe to show to end users. Anything that is not an AppError is treated as internal and
 * is never serialised to clients.
 */
export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payload_too_large'
  | 'quota_exceeded'
  | 'not_configured'
  | 'upstream_error'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  payload_too_large: 413,
  quota_exceeded: 402,
  not_configured: 503,
  upstream_error: 502,
  internal: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') =>
  new AppError('forbidden', msg);
export const notConfigured = (msg: string) => new AppError('not_configured', msg);

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

/** Convert any thrown value into a client-safe body. Unknown errors become a generic 500. */
export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'Internal server error' } },
  };
}
