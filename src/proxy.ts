import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { canonicalOrigin } from '@/lib/origin'

/**
 * Keeps every student on one origin.
 *
 * A Vercel production deployment answers on two hosts: its immutable
 * `…-<hash>-<team>.vercel.app` URL and the project alias. `localStorage` is
 * scoped per origin and the device binding lives there, so a student who
 * registers on one host and later opens the other is told "Not registered"
 * while the database insists their roll number is already claimed — a device
 * reset per student, looking exactly like lost data.
 *
 * The QR now carries the canonical origin, which fixes new scans. This catches
 * the rest: a bookmark, a link someone forwarded, a QR still on a slide.
 *
 * Scoped deliberately:
 *  - only the two student-facing routes, so if the canonical origin were ever
 *    wrong the home page and `/admin` still answer and this is one revert away;
 *  - only on production deployments, so preview deployments stay testable
 *    instead of bouncing to production;
 *  - and it cannot loop, because after the redirect the host equals the
 *    canonical host and the comparison below is false.
 */
export function proxy(req: NextRequest) {
  if (process.env.VERCEL_ENV !== 'production') return NextResponse.next()

  const canonical = canonicalOrigin()
  if (!canonical) return NextResponse.next()

  let canonicalHost: string
  try {
    canonicalHost = new URL(canonical).host
  } catch {
    return NextResponse.next()
  }

  const host = req.headers.get('host')
  if (!host || host === canonicalHost) return NextResponse.next()

  const target = new URL(req.nextUrl.pathname + req.nextUrl.search, canonical)
  // 307: keep the method, and never let a browser cache a host change.
  return NextResponse.redirect(target, 307)
}

export const config = {
  matcher: ['/m', '/me'],
}
