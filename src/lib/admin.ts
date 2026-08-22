import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { env } from './env'
import { db } from './supabase'

export const ADMIN_COOKIE = 'att_admin'
const PRIMARY_TTL_SECONDS = 60 * 60 * 12 // one teaching day

/**
 * Who is making the request.
 *
 * `primary` is the instructor, holding ADMIN_PASSWORD. `deputy` is someone
 * covering for them, holding a time-limited code. A deputy can run a class —
 * sessions, the QR, marking attendance — but never touches identity: device
 * resets, the enrollment window and issuing further access stay with the
 * primary, and their spreadsheet comes out view-only.
 */
export type Principal =
  | { kind: 'primary' }
  | { kind: 'deputy'; grantId: string; label: string; expiresAt: string }

export function actorOf(p: Principal): string {
  return p.kind === 'primary' ? 'primary' : `deputy:${p.label}`
}

/* ── grant codes ────────────────────────────────────────────────────────── */

/** No I/O/0/1 — these get read aloud and typed on a phone. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12

export function generateCode(): string {
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  // Grouped for reading out; normalised away before hashing.
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
}

export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * A plain SHA-256 is right here: the code is 12 random characters from a
 * 30-symbol alphabet (~59 bits), so there is no dictionary to slow down — only
 * brute force, which the entropy already defeats.
 */
export function hashCode(input: string): string {
  return createHash('sha256').update(normaliseCode(input)).digest('hex')
}

export function looksLikeCode(input: unknown): input is string {
  return typeof input === 'string' && normaliseCode(input).length === CODE_LENGTH
}

/* ── cookies ────────────────────────────────────────────────────────────── */

function sign(payload: string): string {
  return createHmac('sha256', env.adminPassword).update(payload).digest('base64url')
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * `secure` follows the actual request scheme rather than NODE_ENV.
 *
 * `next start` runs with NODE_ENV=production, so keying off it marked the cookie
 * Secure even when served over plain HTTP on a LAN address — and a Secure cookie
 * on http:// is silently dropped by Safari, and by Chrome for anything other
 * than localhost. Sign-in then "succeeded" and left you on the login page.
 * Production is unaffected: it is HTTPS, so the flag is still set.
 */
function cookieOptions(maxAge: number, secure: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
    maxAge,
  }
}

/** True when the request actually arrived over HTTPS. */
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim() === 'https'
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Primary cookie is `p.<expiry>.<hmac>`, signed with ADMIN_PASSWORD. No session
 * store: the signature is the proof, and changing the password invalidates every
 * outstanding cookie of both kinds.
 */
export function mintAdminCookie(secure: boolean, now: number = Date.now()) {
  const exp = Math.floor(now / 1000) + PRIMARY_TTL_SECONDS
  return {
    name: ADMIN_COOKIE,
    value: `p.${exp}.${sign(`admin:${exp}`)}`,
    options: cookieOptions(PRIMARY_TTL_SECONDS, secure),
  }
}

/**
 * Deputy cookie is `g.<grantId>.<expiry>.<hmac>`. The signature stops forgery,
 * but the grant row is still read on every request — that is what makes
 * revoking take effect immediately rather than whenever the cookie lapses.
 */
export function mintDeputyCookie(
  grantId: string,
  grantExpiresAtMs: number,
  secure: boolean,
  now = Date.now()
) {
  const maxAge = Math.max(60, Math.floor((grantExpiresAtMs - now) / 1000))
  const exp = Math.floor(now / 1000) + maxAge
  return {
    name: ADMIN_COOKIE,
    value: `g.${grantId}.${exp}.${sign(`grant:${grantId}:${exp}`)}`,
    options: cookieOptions(maxAge, secure),
  }
}

/** Constant-time password check, so a wrong guess leaks nothing by timing. */
export function passwordMatches(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  return equal(candidate, env.adminPassword)
}

/* ── resolution ─────────────────────────────────────────────────────────── */

async function resolveDeputy(
  grantId: string,
  now: number
): Promise<Principal | null> {
  const { data, error } = await db()
    .from('admin_grants')
    .select('id, label, expires_at, revoked_at')
    .eq('id', grantId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  if (data.revoked_at !== null) return null
  if (new Date(data.expires_at).getTime() <= now) return null
  return {
    kind: 'deputy',
    grantId: data.id,
    label: data.label,
    expiresAt: data.expires_at,
  }
}

/** Resolves the cookie into a principal, or null. Never trusts client input. */
export async function currentPrincipal(now: number = Date.now()): Promise<Principal | null> {
  const raw = (await cookies()).get(ADMIN_COOKIE)?.value
  if (!raw) return null
  const parts = raw.split('.')

  if (parts[0] === 'p' && parts.length === 3) {
    const exp = Number(parts[1])
    if (!Number.isSafeInteger(exp) || exp * 1000 < now) return null
    if (!equal(sign(`admin:${exp}`), parts[2])) return null
    return { kind: 'primary' }
  }

  if (parts[0] === 'g' && parts.length === 4) {
    const [, grantId, expRaw, mac] = parts
    const exp = Number(expRaw)
    if (!Number.isSafeInteger(exp) || exp * 1000 < now) return null
    if (!equal(sign(`grant:${grantId}:${exp}`), mac)) return null
    return resolveDeputy(grantId, now)
  }

  return null
}

/** True for any signed-in admin, primary or deputy. */
export async function isAdmin(): Promise<boolean> {
  return (await currentPrincipal()) !== null
}
