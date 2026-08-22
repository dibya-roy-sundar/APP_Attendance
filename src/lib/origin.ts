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

  if (req) return requestOrigin(req)
  return ''
}

/**
 * The origin as the *browser* sees it, taken from the Host header rather than
 * `req.url`.
 *
 * Next resolves `req.url` through its own normalisation, which reports
 * `localhost` for a request the browser actually made to `127.0.0.1`. That
 * difference is invisible almost everywhere — and fatal for passkeys, because
 * WebAuthn requires the Relying Party ID to be a suffix of the document's host.
 * A page on `127.0.0.1` handed an RP ID of `localhost` makes the browser refuse
 * to create a credential at all, with no request reaching the server to explain
 * why.
 */
function requestOrigin(req: Request): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (!host) return new URL(req.url).origin
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0].trim() ??
    new URL(req.url).protocol.replace(':', '')
  return `${proto}://${host}`
}

/** The URL that goes into the QR code. */
export function scanUrl(req: Request, sessionId: string, token: string): string {
  const origin = canonicalOrigin(req) || new URL(req.url).origin
  return `${origin}/m?s=${encodeURIComponent(sessionId)}&t=${encodeURIComponent(token)}`
}
