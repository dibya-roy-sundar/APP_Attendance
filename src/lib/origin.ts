/**
 * The one origin students are ever sent to.
 *
 * `localStorage` is scoped per origin, and the device binding lives there. A
 * Vercel production deployment answers on two hosts — its immutable
 * `…-<hash>-<team>.vercel.app` URL and the project alias — so a QR built from
 * `window.location.origin` sends the class to whichever one the admin happened
 * to have open. A student who registers on the deployment URL then opens the
 * alias has no binding under that origin and is told "Not registered", while
 * the database says their roll number is already claimed. That costs a device
 * reset each time and looks exactly like data loss.
 *
 * So the scan URL is built on the server from a fixed origin, never from
 * whatever host the admin's browser is on.
 *
 * Resolution order:
 *  1. `APP_ORIGIN` — set this once a real domain exists.
 *  2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel injects the project's production
 *     alias, which is what we want on every deployment including previews.
 *  3. The request's own origin, so `next dev` and the local suites still work.
 */
export function canonicalOrigin(req?: Request): string {
  const explicit = process.env.APP_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const alias = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
  if (alias) return `https://${alias.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`

  if (req) return new URL(req.url).origin
  return ''
}

/** The URL that goes into the QR code. */
export function scanUrl(req: Request, sessionId: string, token: string): string {
  const origin = canonicalOrigin(req) || new URL(req.url).origin
  return `${origin}/m?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`
}
