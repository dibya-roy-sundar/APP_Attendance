import {
  isSecureRequest,
  hashCode,
  looksLikeCode,
  mintAdminCookie,
  mintDeputyCookie,
  passwordMatches,
} from '@/lib/admin'
import { fail, ok, readJson } from '@/lib/api'
import { db } from '@/lib/supabase'
import { callerKey, checkThrottle, clearFailures, recordFailure } from '@/lib/throttle'
import { cookies } from 'next/headers'

/**
 * One form, two credentials: the instructor's password, or a deputy's temporary
 * code. Deputies never receive the password — that could not be revoked, and
 * would hand over device resets and the enrollment window with it.
 */
export async function POST(req: Request) {
  const body = await readJson(req)
  const secret = body.password
  const caller = callerKey(req)
  const secure = isSecureRequest(req)

  // One shared password guards every attendance record, so unlimited guessing is
  // not acceptable even though the generated default is strong.
  const throttle = await checkThrottle(caller)
  if (throttle.blocked) {
    return fail('TOO_MANY_ATTEMPTS', 429, { retryAfterSeconds: throttle.retryAfterSeconds })
  }

  if (passwordMatches(secret)) {
    await clearFailures(caller)
    const cookie = mintAdminCookie(secure)
    ;(await cookies()).set(cookie.name, cookie.value, cookie.options)
    return ok({ status: 'OK', role: 'primary' })
  }

  // Fall through to a grant code. Looked up by hash, so the comparison is an
  // index hit rather than a scan over candidate rows.
  if (looksLikeCode(secret)) {
    const { data, error } = await db()
      .from('admin_grants')
      .select('id, label, expires_at, revoked_at')
      .eq('code_hash', hashCode(secret))
      .maybeSingle()
    if (error) throw error

    if (data && data.revoked_at === null) {
      const expiresAt = new Date(data.expires_at).getTime()
      if (expiresAt > Date.now()) {
        await db()
          .from('admin_grants')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', data.id)

        await clearFailures(caller)
        const cookie = mintDeputyCookie(data.id, expiresAt, secure)
        ;(await cookies()).set(cookie.name, cookie.value, cookie.options)
        return ok({
          status: 'OK',
          role: 'deputy',
          label: data.label,
          expiresAt: data.expires_at,
        })
      }
      await recordFailure(caller)
      return fail('CODE_EXPIRED', 401)
    }
    if (data) {
      await recordFailure(caller)
      return fail('CODE_REVOKED', 401)
    }
  }

  await recordFailure(caller)
  return fail('BAD_PASSWORD', 401)
}
