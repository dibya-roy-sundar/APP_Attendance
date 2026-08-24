'use client'

import { useCallback, useEffect, useState } from 'react'

type Request = {
  id: string
  studentId: string
  rollNo: string
  name: string
  deviceLabel: string | null
  requestedAt: string
  decision: 'approved' | 'rejected' | null
  decidedAt: string | null
}

type Filter = 'all' | 'pending' | 'approved' | 'rejected'
// 'rejected' is the stored value; "Refused" is what a person reads, and it has to
// match the badge on the row or the same state appears to have two names.
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Refused' },
]

/**
 * The last week of claims on roll numbers that already have a passkey.
 *
 * Deliberately just a log with two buttons. It shows who asked, from what, when
 * and what was decided, and makes no attempt to guess which claims are honest.
 *
 * An earlier version flagged whether the student was already marked present and
 * when their old passkey last worked. Both went, because neither discriminates
 * where it matters: a proxy attempt happens while the student is absent, and so
 * does a genuine lost phone. A hint that only fires in the rare case is worse
 * than none — it invites trusting it instead of asking the student, and the
 * admin is standing in a room with all 47 of them.
 *
 * What the history is actually good for is patterns: the same roll number
 * claimed three times in a week is visible at a glance, and no heuristic was
 * needed to surface it.
 */
export function RequestsPanel({
  isPrimary,
  onDecided,
}: {
  isPrimary: boolean
  onDecided: (message: string) => void
}) {
  const [requests, setRequests] = useState<Request[] | null>(null)
  const [filter, setFilter] = useState<Filter>('pending')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/passkey/requests', { cache: 'no-store' })
      setRequests(res.ok ? ((await res.json()).requests ?? []) : [])
    } catch {
      setRequests([])
    }
  }, [])

  useEffect(() => {
    let live = true
    // Deferred rather than called from the effect body, which would set state
    // during the same commit and cascade a second render.
    const first = setTimeout(() => {
      if (live) void load()
    }, 0)
    // Slow poll — these arrive at human speed.
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
            : `Refused. ${request.name} keeps their existing passkey.`
          : 'Could not apply that decision.'
      )
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (requests === null) return null

  const counts: Record<Filter, number> = {
    all: requests.length,
    pending: requests.filter((r) => r.decision === null).length,
    approved: requests.filter((r) => r.decision === 'approved').length,
    rejected: requests.filter((r) => r.decision === 'rejected').length,
  }
  const shown =
    filter === 'all' ? requests : requests.filter((r) => (r.decision ?? 'pending') === filter)

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm font-medium">Phone changes</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Someone entered a roll number that already has a passkey. Approve only
          if that student really has changed phone — approving moves their
          attendance to the new one. Last 7 days.
        </p>
      </div>

      <div role="group" aria-label="Filter requests" className="flex flex-wrap gap-1.5">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
            className={`min-h-11 rounded-lg px-3 text-sm ${
              filter === key
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'border border-slate-300 dark:border-slate-700'
            }`}
          >
            {label}
            <span className="ml-1.5 tabular-nums opacity-60">{counts[key]}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {filter === 'pending'
            ? 'Nothing waiting.'
            : filter === 'all'
              ? 'No requests in the last 7 days.'
              : `Nothing ${filter === 'rejected' ? 'refused' : 'approved'} in the last 7 days.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((r) => (
            <li
              key={r.id}
              className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium">
                  {r.name}{' '}
                  <span className="font-normal text-slate-500 dark:text-slate-400">
                    {r.rollNo}
                  </span>
                </p>
                <Status decision={r.decision} />
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                from {r.deviceLabel ?? 'an unrecognised device'} · {when(r.requestedAt)}
              </p>

              {r.decision === null && isPrimary && (
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
              )}
              {r.decision === null && !isPrimary && (
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  Only the admin can decide this.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Status({ decision }: { decision: 'approved' | 'rejected' | null }) {
  const [label, tone] =
    decision === 'approved'
      ? ['Approved', 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300']
      : decision === 'rejected'
        ? ['Refused', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300']
        : ['Pending', 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300']
  return (
    <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  )
}

/** "14:32 today", "Mon 14:32" — enough to place it in the week. */
function when(iso: string): string {
  const at = new Date(iso)
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at)
  const sameDay = new Date().toDateString() === at.toDateString()
  if (sameDay) return `${time} today`
  return `${new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(at)} ${time}`
}
