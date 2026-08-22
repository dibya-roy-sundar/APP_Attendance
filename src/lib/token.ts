import { createHmac, timingSafeEqual } from 'node:crypto'

/** Rotation period used when the admin does not choose one. */
export const DEFAULT_WINDOW_SECONDS = 15

/**
 * Bounds on the rotation period. Below ~5s ordinary clock skew and camera lag
 * start rejecting honest scans; above a few minutes a forwarded screenshot stays
 * usable long enough to defeat the point of rotating at all.
 */
export const MIN_WINDOW_SECONDS = 5
export const MAX_WINDOW_SECONDS = 300

/** Number of characters kept from the base64url digest. */
export const TOKEN_LENGTH = 12

export function isValidWindowSeconds(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= MIN_WINDOW_SECONDS &&
    v <= MAX_WINDOW_SECONDS
  )
}

/** The rotation window index that contains `atMs`. */
export function currentWindow(
  atMs: number = Date.now(),
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): number {
  return Math.floor(atMs / 1000 / windowSeconds)
}

/**
 * The token a client should present for `sessionId` during window `w`.
 *
 * The period is not part of the HMAC input: `w` is already derived from it, so a
 * session that rotates every 60s produces an entirely different index sequence
 * from one rotating every 15s.
 */
export function tokenFor(secret: string, sessionId: string, w: number): string {
  return createHmac('sha256', secret)
    .update(`${sessionId}:${w}`)
    .digest('base64url')
    .slice(0, TOKEN_LENGTH)
}

/** The token to encode in the QR right now. */
export function currentToken(
  secret: string,
  sessionId: string,
  atMs: number = Date.now(),
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): string {
  return tokenFor(secret, sessionId, currentWindow(atMs, windowSeconds))
}

/** Milliseconds until the current window flips. Drives the client's refresh timer. */
export function msUntilNextWindow(
  atMs: number = Date.now(),
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): number {
  const period = windowSeconds * 1000
  return period - (atMs % period)
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Accepts the token for the current window `w` and the previous one `w-1`, so a
 * student who was mid-scan when the QR flipped still succeeds. Never accepts
 * `w+1` — that would let a screenshot be used before the code it shows is live.
 *
 * The grace is always one period, so a longer rotation buys a longer grace. That
 * is the trade the admin makes when they choose the period.
 */
export function verifyToken(
  secret: string,
  sessionId: string,
  token: string,
  atMs: number = Date.now(),
  windowSeconds: number = DEFAULT_WINDOW_SECONDS
): boolean {
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH) return false
  const w = currentWindow(atMs, windowSeconds)
  let ok = false
  // Compare against both windows unconditionally: no early return, so the
  // work done does not depend on which window matched.
  for (const candidate of [w, w - 1]) {
    if (constantTimeEquals(tokenFor(secret, sessionId, candidate), token)) ok = true
  }
  return ok
}
