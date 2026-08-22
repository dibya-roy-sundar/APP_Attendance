'use client'

import { useMemo, useState } from 'react'

export type Day = { classDate: string; present: boolean; markedAt: string | null }

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** `YYYY-MM` for grouping, and the pieces needed to lay out a month grid. */
function monthKey(dateStr: string) {
  return dateStr.slice(0, 7)
}

function monthLabel(key: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${key}-01T00:00:00Z`))
}

/** Days in the month, and how many blanks precede day 1 on a Monday-first grid. */
function monthShape(key: string) {
  const [y, m] = key.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  // getUTCDay is 0=Sunday; shift so Monday is 0.
  const lead = (first.getUTCDay() + 6) % 7
  return { days, lead, y, m }
}

/**
 * A month view of the student's own attendance.
 *
 * Only days that actually had a class carry a mark — an empty square means no
 * class was held, which is materially different from being absent, and a list of
 * dates cannot show that distinction at a glance.
 */
export function Calendar({ days }: { days: Day[] }) {
  const byMonth = useMemo(() => {
    const map = new Map<string, Map<number, Day>>()
    for (const d of days) {
      const key = monthKey(d.classDate)
      if (!map.has(key)) map.set(key, new Map())
      map.get(key)!.set(Number(d.classDate.slice(8, 10)), d)
    }
    return map
  }, [days])

  const months = useMemo(() => [...byMonth.keys()].sort(), [byMonth])
  const [index, setIndex] = useState(() => Math.max(0, months.length - 1))

  if (months.length === 0) {
    return (
      <p className="rounded-2xl bg-white p-5 text-sm text-slate-500 dark:text-slate-400 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
        No classes recorded yet. Your attendance will appear here after the first
        one.
      </p>
    )
  }

  const key = months[Math.min(index, months.length - 1)]
  const inMonth = byMonth.get(key) ?? new Map<number, Day>()
  const { days: dayCount, lead } = monthShape(key)
  const present = [...inMonth.values()].filter((d) => d.present).length
  const held = inMonth.size

  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index <= 0}
          aria-label="Previous month"
          className="tap-square rounded-lg text-xl leading-none text-slate-500 dark:text-slate-400 disabled:opacity-30"
        >
          ‹
        </button>
        <div className="text-center">
          <p className="font-medium">{monthLabel(key)}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {held === 0
              ? 'No classes'
              : `${present} of ${held} ${held === 1 ? 'class' : 'classes'}`}
          </p>
        </div>
        <button
          onClick={() => setIndex((i) => Math.min(months.length - 1, i + 1))}
          disabled={index >= months.length - 1}
          aria-label="Next month"
          className="tap-square rounded-lg text-xl leading-none text-slate-500 dark:text-slate-400 disabled:opacity-30"
        >
          ›
        </button>
      </div>

      <div className="mt-4 grid grid-cols-7 gap-1" role="grid">
        {WEEKDAYS.map((w, i) => (
          <div
            key={i}
            aria-hidden
            className="pb-1 text-center text-[11px] font-medium text-slate-500 dark:text-slate-400"
          >
            {w}
          </div>
        ))}

        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} aria-hidden />
        ))}

        {Array.from({ length: dayCount }, (_, i) => {
          const dayNo = i + 1
          const day = inMonth.get(dayNo)
          const base =
            'flex aspect-square flex-col items-center justify-center rounded-lg text-sm tabular-nums'

          if (!day) {
            return (
              <div key={dayNo} className={`${base} text-slate-500 dark:text-slate-400`}>
                {dayNo}
              </div>
            )
          }

          const label = `${dayNo} ${monthLabel(key)} — ${day.present ? 'present' : 'absent'}`
          return (
            <div
              key={dayNo}
              title={label}
              aria-label={label}
              className={`${base} font-medium ring-1 ${
                day.present
                  ? 'bg-emerald-50 text-emerald-900 ring-emerald-600/40 dark:bg-emerald-950/50 dark:text-emerald-200'
                  : 'bg-red-50 text-red-900 ring-red-600/40 dark:bg-red-950/50 dark:text-red-200'
              }`}
            >
              <span>{dayNo}</span>
              <span aria-hidden className="text-[11px] leading-none">
                {day.present ? '✓' : '✕'}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:text-slate-400 dark:border-slate-800">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-emerald-500/70" aria-hidden />
          Present
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-red-500/70" aria-hidden />
          Absent
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-slate-200 dark:bg-slate-700" aria-hidden />
          No class
        </span>
      </div>
    </div>
  )
}
