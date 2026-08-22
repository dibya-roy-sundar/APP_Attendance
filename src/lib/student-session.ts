import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '@/lib/env'
import type { NextResponse } from 'next/server'

/**
 * A short-lived session established by a passkey.
 *
 * The passkey is the identity; this is only so a student can look at their own
 * attendance record without a biometric prompt on every page view. Marking
 * present never relies on it — that always takes a fresh passkey assertion plus
 * a live QR token, so a stolen session cookie cannot mark anybody present.
 *
 * Signed with the same secret as the admin cookie, so rotating the password
 * invalidates every outstanding session of either kind.
 */
const COOKIE = 'att_student'
const TTL_SECONDS = 30 * 24 * 60 * 60

function sign(payload: string): string {
  return createHmac('sha256', env.adminPassword).update(payload).digest('base64url')
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function setStudentSession(
  res: NextResponse,
  studentId: string,
  secure: boolean,
  now: number = Date.now()
): NextResponse {
  const exp = Math.floor(now / 1000) + TTL_SECONDS
  res.cookies.set(COOKIE, `${studentId}.${exp}.${sign(`student:${studentId}:${exp}`)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: TTL_SECONDS,
  })
  return res
}

export function clearStudentSession(res: NextResponse): NextResponse {
  res.cookies.set(COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}

/** The student id this request carries, or null. Signature and expiry checked. */
export function readStudentSession(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  let raw: string | null = null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === COOKIE) raw = decodeURIComponent(rest.join('='))
  }
  if (!raw) return null

  const [studentId, expText, mac] = raw.split('.')
  if (!studentId || !expText || !mac) return null
  const exp = Number(expText)
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) return null
  if (!equal(mac, sign(`student:${studentId}:${exp}`))) return null
  return studentId
}
