'use client'

import { useCallback, useEffect, useState } from 'react'

type Request = {
  id: string
  studentId: string
  rollNo: string
  name: string
  deviceLabel: string | null
  requestedAt: string
  markedToday: boolean
}

/**
 * Claims on roll numbers that already have a passkey.
 *
 * A lost phone and an attempted proxy are indistinguishable to the server, so
 * both land here and a person decides. The panel's job is to give that person
 * the one fact that actually separates them: whether the student is already
 * marked present today. Someone who has been marked and is now asking to move
 * their passkey is a very different story from someone who has not turned up.
 */
export function RequestsPanel({
  isPrimary,
  onDecided,
}: {
  isPrimary: boolean
  onDecided: (message: string) => void
}) {
  const [requests, setRequests] = useState<Request[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/passkey/requests', { cache: 'no-store' })
      if (!res.ok) return setRequests([])
      setRequests((await res.json()).requests ?? [])
    } catch {
      setRequests([])
    }
  }, [])

  useEffect(() => {
    let live = true
    // Deferred rather than called straight from the effect body: loading in the
    // body sets state during the same commit and cascades a second render.
    const first = setTimeout(() => {
      if (live) void load()
    }, 0)
    // Slow poll — these arrive at human speed, not machine speed.
    const timer = setInterval(() => {
      if (live) void load()
    }, 15_000)
    return () => {
      live = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [load])

  async function decide(request: Request, approve: boolean) {
    setBusy(request.id)
    try {
      const res = await fetch('/api/passkey/requests/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request.id, approve }),
      })
      onDecided(
        res.ok
          ? approve
            ? `${request.name} can now mark attendance from that phone.`
            : `Refused. ${request.name} keeps their existing passkey, and the attempt is recorded.`
          : 'Could not apply that decision.'
      )
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (requests === null) return null
  if (requests.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No phone-change requests waiting.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">Phone-change requests</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Somebody entered a roll number that already has a passkey. Approve only
          if you believe that student really has changed phone — approving moves
          their attendance to the new one.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {requests.map((r) => (
          <li
            key={r.id}
            className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10"
          >
            <p className="text-sm font-medium">
              {r.name}{' '}
              <span className="font-normal text-slate-500 dark:text-slate-400">
                {r.rollNo}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              from {r.deviceLabel ?? 'an unrecognised device'} ·{' '}
              {new Intl.DateTimeFormat('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              }).format(new Date(r.requestedAt))}
            </p>

            {/* The fact that decides it, stated rather than implied. */}
            <p
              className={`mt-1.5 text-xs font-medium ${
                r.markedToday
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {r.markedToday
                ? 'Already marked present today — so this phone is not the one that marked them.'
                : 'Not marked present today.'}
            </p>

            {isPrimary ? (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void decide(r, true)}
                  disabled={busy === r.id}
                  className="min-h-11 rounded-lg bg-slate-900 px-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
                >
                  {busy === r.id ? 'Working…' : 'Approve'}
                </button>
                <button
                  onClick={() => void decide(r, false)}
                  disabled={busy === r.id}
                  className="min-h-11 rounded-lg border border-slate-300 px-3 text-sm disabled:opacity-40 dark:border-slate-700"
                >
                  Refuse
                </button>
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Only the admin can decide this.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
