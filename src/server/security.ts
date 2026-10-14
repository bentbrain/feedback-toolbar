import { createHash, randomBytes } from 'node:crypto';

export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue<T>(value: T | undefined, message = 'Not found.'): T {
  if (value === undefined) throw new HttpError(404, message);
  return value;
}
