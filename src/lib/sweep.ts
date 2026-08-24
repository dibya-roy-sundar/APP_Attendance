import { after } from 'next/server'
import { pruneChallenges, pruneRequests } from './passkey'

/**
 * Housekeeping deletes, moved off the request path.
 *
 * Both of these tables are self-limiting by query rather than by cleanup: a
 * lapsed challenge cannot be consumed because consumption filters on
 * `expires_at`, and a stale request is invisible because the panel filters on
 * `requested_at`. Deleting the rows is therefore tidying, not correctness — so
 * it has no business costing the student a round trip to Supabase while they
 * wait for a biometric prompt.
 *
 * `after` rather than a bare un-awaited promise: on Vercel the container can be
 * frozen the moment the response is flushed, which would abandon the delete
 * halfway. `after` keeps the function alive until it finishes.
 *
 * Errors are swallowed. A delete that did not happen has no visible
 * consequence, the next call attempts it again, and a failure here must never
 * turn a working sign-in into a broken one.
 */
export function sweepChallenges(): void {
  after(async () => {
    try {
      await pruneChallenges()
    } catch {
      // Housekeeping only. The next challenge minted tries again.
    }
  })
}

/** As above, for the phone-change queue. */
export function sweepRequests(): void {
  after(async () => {
    try {
      await pruneRequests()
    } catch {
      // Housekeeping only. The next time the panel is opened tries again.
    }
  })
}
