import { normaliseDeviceId } from '@/lib/api'
import type { NextResponse } from 'next/server'

const COOKIE = 'att_dev'
// Browsers cap cookie lifetimes near 400 days; a term is far shorter.
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60

/**
 * A second, durable copy of the device binding.
 *
 * `localStorage` is the primary store, but Safari's Intelligent Tracking
 * Prevention deletes *script-writable* storage — localStorage, IndexedDB,
 * cookies written by JavaScript — after roughly seven days of browser use
 * without interaction on the site. A weekly class sits exactly on that
 * boundary, and when it fires the student's phone forgets who it is while the
 * database still holds their old id. They are then told their own roll number
 * belongs to another phone, and every one of them needs an admin device reset.
 *
 * A cookie set by the *server* is not script-writable, so it is not subject to
 * that cap. Holding the same id in both places means either one surviving is
 * enough, and each request re-writes the other. It is also httpOnly, so unlike
 * the localStorage copy it cannot be read by script at all.
 *
 * This is durability, not authentication: whoever holds the id is treated as
 * that student, exactly as before. Clearing website data still clears both.
 */
export function readDeviceCookie(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) return normaliseDeviceId(decodeURIComponent(rest.join('=')))
  }
  return null
}

/** Re-write the cookie on every recognised scan, so it never quietly lapses. */
export function setDeviceCookie(res: NextResponse, deviceId: string, secure: boolean): NextResponse {
  res.cookies.set(COOKIE, deviceId, {
    httpOnly: true,
    // Lax, not Strict: the scan arrives as a top-level navigation from the
    // camera app, and Strict would withhold the cookie on exactly that hop.
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
  return res
}
