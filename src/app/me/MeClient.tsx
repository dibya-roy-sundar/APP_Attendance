'use client'

import { Spinner } from '@/components/Spinner'
import { ThemeToggle } from '@/components/ThemeToggle'
import { deviceId } from '@/lib/device'
import { useEffect, useState } from 'react'
import { Calendar, type Day } from './Calendar'
type Me = {
  name: string
  rollNo: string
  present: number
  total: number
  percent: number | null
  days: Day[]
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; me: Me }
  | { kind: 'unknown' }
  | { kind: 'offline' }

function formatDate(d: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${d}T00:00:00Z`))
}

/**
 * The page students actually use. Excel with 23 columns on a phone is unusable,
 * so this shows one number and one list — and only ever their own row.
 */
export function MeClient() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/me', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: deviceId() }),
        })
        if (cancelled) return
        if (res.status === 404) return setState({ kind: 'unknown' })
        if (!res.ok) return setState({ kind: 'offline' })
        setState({ kind: 'ready', me: await res.json() })
      } catch {
        if (!cancelled) setState({ kind: 'offline' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'loading') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center justify-center p-6">
        <Spinner label="Loading your attendance…" />
      </main>
    )
  }

  if (state.kind === 'unknown') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center p-6">
        <div className="w-full rounded-2xl bg-amber-50 p-6 text-center ring-1 ring-amber-500/30 dark:bg-amber-950/40">
          <h1 className="text-xl font-semibold">Not registered</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            This phone is not linked to a student yet. Ask the instructor to open
            registration, then scan the QR code in class.
          </p>
        </div>
      </main>
    )
  }

  if (state.kind === 'offline') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md items-center p-6">
        <div className="w-full rounded-2xl bg-amber-50 p-6 text-center ring-1 ring-amber-500/30 dark:bg-amber-950/40">
          <h1 className="text-xl font-semibold">Could not load</h1>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Check your connection and reload.
          </p>
        </div>
      </main>
    )
  }

  const { me } = state
  return (
    <main className="mx-auto max-w-md p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{me.name}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{me.rollNo}</p>
        </div>
        <ThemeToggle compact />
      </header>

      <section className="mt-6 rounded-2xl bg-white p-5 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
        <p className="text-3xl font-semibold tabular-nums">
          {me.present} / {me.total}
          {me.percent !== null && (
            <span className="ml-2 text-lg font-normal text-slate-500 dark:text-slate-400">
              {me.percent.toFixed(1)}%
            </span>
          )}
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {me.total === 0 ? 'No classes recorded yet.' : 'Classes attended'}
        </p>
      </section>

      <div className="mt-6">
        <Calendar days={me.days} />
      </div>

      {me.days.length > 0 && (
        <>
          <h2 className="mt-8 mb-2 text-sm font-medium text-slate-500 dark:text-slate-400">
            Every class
          </h2>
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/10 dark:divide-slate-800 dark:bg-slate-900 dark:ring-white/10">
            {me.days.map((d) => (
              <li key={d.classDate} className="flex items-center gap-3 px-5 py-3">
                <span
                  aria-hidden
                  className={
                    d.present
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-slate-500 dark:text-slate-400'
                  }
                >
                  {d.present ? '✓' : '·'}
                </span>
                <span className="flex-1">{formatDate(d.classDate)}</span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {d.present ? 'Present' : 'Absent'}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

    </main>
  )
}
