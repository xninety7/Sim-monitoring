import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

export const usernameRule = 'Usernames use lowercase letters, numbers, dots, dashes or underscores (max 50).';
export const passwordRule = 'Password must be 8 to 200 characters.';

export function isValidUsername(username) {
  return /^[a-z0-9._-]{1,50}$/.test(username);
}

export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}
const keyLength = 64;
const cost = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, keyLength, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, storedHash) {
  const [scheme, N, r, p, salt, key] = String(storedHash).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}
