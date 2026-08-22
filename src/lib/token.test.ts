import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_SECONDS as WINDOW,
  MAX_WINDOW_SECONDS,
  MIN_WINDOW_SECONDS,
  TOKEN_LENGTH,
  currentToken,
  currentWindow,
  isValidWindowSeconds,
  msUntilNextWindow,
  tokenFor,
  verifyToken,
} from './token'

const SECRET = 'a'.repeat(64)
const OTHER_SECRET = 'b'.repeat(64)
const SESSION = '11111111-1111-1111-1111-111111111111'
const OTHER_SESSION = '22222222-2222-2222-2222-222222222222'

const at = (w: number, offsetMs = 0) => w * WINDOW * 1000 + offsetMs
/** A time sitting exactly on a window boundary. */
const T0 = at(113_333_333)

describe('window arithmetic', () => {
  it('advances once per WINDOW seconds', () => {
    const w = currentWindow(T0)
    expect(currentWindow(T0 + (WINDOW - 1) * 1000)).toBe(w)
    expect(currentWindow(T0 + WINDOW * 1000)).toBe(w + 1)
  })

  it('reports time remaining in the window', () => {
    expect(msUntilNextWindow(at(100))).toBe(WINDOW * 1000)
    expect(msUntilNextWindow(at(100, 1000))).toBe(WINDOW * 1000 - 1000)
    expect(msUntilNextWindow(at(100, WINDOW * 1000 - 1))).toBe(1)
  })
})

describe('token generation', () => {
  it('is 12 base64url characters', () => {
    const t = tokenFor(SECRET, SESSION, 100)
    expect(t).toHaveLength(TOKEN_LENGTH)
    expect(t).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('is deterministic for the same inputs', () => {
    expect(tokenFor(SECRET, SESSION, 100)).toBe(tokenFor(SECRET, SESSION, 100))
  })

  it('differs across windows, sessions and secrets', () => {
    const base = tokenFor(SECRET, SESSION, 100)
    expect(tokenFor(SECRET, SESSION, 101)).not.toBe(base)
    expect(tokenFor(SECRET, OTHER_SESSION, 100)).not.toBe(base)
    expect(tokenFor(OTHER_SECRET, SESSION, 100)).not.toBe(base)
  })

  it('currentToken matches tokenFor at the current window', () => {
    expect(currentToken(SECRET, SESSION, T0)).toBe(
      tokenFor(SECRET, SESSION, currentWindow(T0))
    )
  })
})

describe('verifyToken', () => {
  const now = at(1000, 4000) // 4s into window 1000

  it('accepts the current window w', () => {
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 1000), now)).toBe(true)
  })

  it('accepts the previous window w-1 — a scan in flight when the QR flipped', () => {
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 999), now)).toBe(true)
  })

  it('rejects the next window w+1 — never trust a code that is not live yet', () => {
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 1001), now)).toBe(false)
  })

  it('rejects w-2 — a screenshot older than two windows is dead', () => {
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 998), now)).toBe(false)
  })

  it('rejects a token minted for another session', () => {
    expect(
      verifyToken(SECRET, SESSION, tokenFor(SECRET, OTHER_SESSION, 1000), now)
    ).toBe(false)
  })

  it('rejects a token minted with another secret', () => {
    expect(
      verifyToken(SECRET, SESSION, tokenFor(OTHER_SECRET, SESSION, 1000), now)
    ).toBe(false)
  })

  it('rejects junk, wrong-length and empty tokens without throwing', () => {
    for (const bad of ['', 'x', 'x'.repeat(11), 'x'.repeat(13), 'x'.repeat(12)]) {
      expect(verifyToken(SECRET, SESSION, bad, now)).toBe(false)
    }
    // Non-strings can arrive from a hand-rolled request body.
    expect(verifyToken(SECRET, SESSION, undefined as unknown as string, now)).toBe(false)
    expect(verifyToken(SECRET, SESSION, null as unknown as string, now)).toBe(false)
    expect(verifyToken(SECRET, SESSION, 12 as unknown as string, now)).toBe(false)
  })

  it('a screenshot is worthless after 40 seconds', () => {
    const scanned = at(1000)
    const token = currentToken(SECRET, SESSION, scanned)
    expect(verifyToken(SECRET, SESSION, token, scanned + 5_000)).toBe(true)
    expect(verifyToken(SECRET, SESSION, token, scanned + 40_000)).toBe(false)
  })

  it('stays valid right up to the end of the grace window', () => {
    const token = tokenFor(SECRET, SESSION, 1000)
    // Last millisecond of window 1001, where 1000 is still w-1.
    expect(verifyToken(SECRET, SESSION, token, at(1002) - 1)).toBe(true)
    // First millisecond of window 1002, where 1000 becomes w-2.
    expect(verifyToken(SECRET, SESSION, token, at(1002))).toBe(false)
  })
})

describe('configurable rotation period', () => {
  const PERIOD = 60
  const atP = (w: number, offsetMs = 0) => w * PERIOD * 1000 + offsetMs

  it('validates the period against its bounds', () => {
    expect(isValidWindowSeconds(15)).toBe(true)
    expect(isValidWindowSeconds(MIN_WINDOW_SECONDS)).toBe(true)
    expect(isValidWindowSeconds(MAX_WINDOW_SECONDS)).toBe(true)
    for (const bad of [
      MIN_WINDOW_SECONDS - 1,
      MAX_WINDOW_SECONDS + 1,
      0,
      -15,
      15.5,
      NaN,
      Infinity,
      '15',
      null,
      undefined,
    ]) {
      expect(isValidWindowSeconds(bad as never)).toBe(false)
    }
  })

  it('advances once per chosen period, not per default', () => {
    const t = atP(500, 30_000) // 30s into a 60s window
    expect(currentWindow(t, PERIOD)).toBe(500)
    expect(currentWindow(t + 29_000, PERIOD)).toBe(500)
    expect(currentWindow(t + 30_000, PERIOD)).toBe(501)
  })

  it('reports time remaining against the chosen period', () => {
    expect(msUntilNextWindow(atP(500), PERIOD)).toBe(60_000)
    expect(msUntilNextWindow(atP(500, 45_000), PERIOD)).toBe(15_000)
  })

  it('accepts w and w-1 at the chosen period', () => {
    const now = atP(500, 5_000)
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 500), now, PERIOD)).toBe(true)
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 499), now, PERIOD)).toBe(true)
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 501), now, PERIOD)).toBe(false)
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 498), now, PERIOD)).toBe(false)
  })

  it('gives a longer grace for a longer period — the admin\'s trade', () => {
    const scanned = atP(500)
    const token = currentToken(SECRET, SESSION, scanned, PERIOD)
    // 40s would already be dead at 15s rotation; at 60s it is still inside w.
    expect(verifyToken(SECRET, SESSION, token, scanned + 40_000, PERIOD)).toBe(true)
    expect(verifyToken(SECRET, SESSION, token, scanned + 119_000, PERIOD)).toBe(true)
    expect(verifyToken(SECRET, SESSION, token, scanned + 120_000, PERIOD)).toBe(false)
  })

  it('a token from one period does not verify under another', () => {
    // Same wall-clock instant, two different rotation settings.
    const now = atP(500, 5_000)
    const at60 = currentToken(SECRET, SESSION, now, 60)
    const at15 = currentToken(SECRET, SESSION, now, 15)
    expect(at60).not.toBe(at15)
    expect(verifyToken(SECRET, SESSION, at60, now, 15)).toBe(false)
    expect(verifyToken(SECRET, SESSION, at15, now, 60)).toBe(false)
  })

  it('defaults to 15s when no period is passed', () => {
    const now = at(1000, 3000)
    expect(verifyToken(SECRET, SESSION, tokenFor(SECRET, SESSION, 1000), now)).toBe(true)
    expect(currentWindow(now)).toBe(currentWindow(now, WINDOW))
  })
})
