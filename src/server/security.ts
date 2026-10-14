import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  if (!(key instanceof Buffer)) throw new Error('Password derivation failed.');
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, expected] = hash.split(':');
  if (!salt || !expected) return false;
  const actual = await derive(password, salt, 64);
  const stored = Buffer.from(expected, 'hex');
  return (
    actual instanceof Buffer && actual.length === stored.length && timingSafeEqual(actual, stored)
  );
}
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
