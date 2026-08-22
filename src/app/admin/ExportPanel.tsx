'use client'

import { useState } from 'react'

const KEY = 'att_export_history'
const MAX_ENTRIES = 20

type Entry = {
  at: string
  from: string | null
  to: string | null
  classes: number
  filename: string
  viewOnly: boolean
}

function readHistory(): Entry[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.slice(0, MAX_ENTRIES) : []
  } catch {
    return []
  }
}

function writeHistory(entries: Entry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Storage disabled or full — the server-side audit log is the real record.
  }
}

function rangeLabel(from: string | null, to: string | null) {
  if (!from && !to) return 'Whole term'
  return `${from ?? 'start'} → ${to ?? 'today'}`
}

function stamp(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

/** `YYYY-MM-DD` for a date n days before today, in the browser's own zone. */
function daysAgo(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function monthStart() {
  const d = new Date()
  return `${d.toISOString().slice(0, 8)}01`
}

/**
 * Download the register, optionally narrowed to a date range, and keep a local
 * list of what was taken.
 *
 * The list records the *range*, not the file. Re-downloading regenerates from
 * the database, so an entry always reflects current attendance — a cached blob
 * would be a second source of truth that could quietly disagree.
 */
export function ExportPanel({ today, viewOnly }: { today: string; viewOnly: boolean }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // Read once at init rather than in an effect. This panel only mounts when the
  // admin opens it, so there is no server render to disagree with.
  const [history, setHistory] = useState<Entry[]>(() =>
    typeof window === 'undefined' ? [] : readHistory()
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download(f: string | null, t: string | null) {
    setBusy(true)
    setError(null)
    try {
      const qs = new URLSearchParams()
      if (f) qs.set('from', f)
      if (t) qs.set('to', t)
      const url = `/api/export${qs.size ? `?${qs}` : ''}`
      const res = await fetch(url)
      if (!res.ok) {
        setError(
          res.status === 400 ? 'That date range is not valid.' : 'Could not build the file.'
        )
        return
      }

      const disposition = res.headers.get('content-disposition') ?? ''
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'soft-skills-attendance.xlsx'
      const classes = Number(res.headers.get('x-export-classes') ?? '0')
      const wasViewOnly = res.headers.get('x-export-view-only') === '1'

      const blob = await res.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = filename
      a.click()
      URL.revokeObjectURL(href)

      const entry: Entry = {
        at: new Date().toISOString(),
        from: f,
        to: t,
        classes,
        filename,
        viewOnly: wasViewOnly,
      }
      const next = [entry, ...history].slice(0, MAX_ENTRIES)
      setHistory(next)
      writeHistory(next)
    } catch {
      setError('No connection.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {viewOnly && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-500/30 dark:bg-amber-950/40 dark:text-amber-200">
          Your copies come out view-only and stamped with your name. The register
          itself is unchanged.
        </p>
      )}

      <div>
        <p className="text-sm font-medium">Download</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            onClick={() => download(null, null)}
            disabled={busy}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            Whole term
          </button>
          <button
            onClick={() => download(monthStart(), today)}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            This month
          </button>
          <button
            onClick={() => download(daysAgo(30), today)}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            Last 30 days
          </button>
        </div>
      </div>

      <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm font-medium">Custom range</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Leave either side blank for open-ended.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500 dark:text-slate-400">
            From
            <input
              type="date"
              max={today}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 text-base dark:border-slate-700"
            />
          </label>
          <label className="text-xs text-slate-500 dark:text-slate-400">
            To
            <input
              type="date"
              max={today}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-lg border border-slate-300 bg-transparent px-2.5 py-1.5 text-base dark:border-slate-700"
            />
          </label>
          <button
            onClick={() => download(from || null, to || null)}
            disabled={busy || (!from && !to)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
          >
            Download range
          </button>
        </div>
        {from && to && from > to && (
          <p className="mt-2 text-xs text-amber-600">
            The start date is after the end date.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">Recent downloads</p>
          {history.length > 0 && (
            <button
              onClick={() => {
                setHistory([])
                writeHistory([])
              }}
              className="inline-flex min-h-11 items-center px-1 text-xs text-slate-500 dark:text-slate-400 underline"
            >
              Clear
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Nothing downloaded on this device yet.
          </p>
        ) : (
          <>
            <ul className="mt-2 flex flex-col gap-1.5">
              {history.map((h, i) => (
                <li
                  key={`${h.at}-${i}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                >
                  <span className="tabular-nums text-slate-500 dark:text-slate-400">{stamp(h.at)}</span>
                  <span className="flex-1 truncate">
                    {rangeLabel(h.from, h.to)}
                    <span className="text-slate-500 dark:text-slate-400">
                      {' · '}
                      {h.classes} {h.classes === 1 ? 'class' : 'classes'}
                      {h.viewOnly ? ' · view-only' : ''}
                    </span>
                  </span>
                  <button
                    onClick={() => download(h.from, h.to)}
                    disabled={busy}
                    className="inline-flex min-h-11 shrink-0 items-center px-1 underline disabled:opacity-40"
                  >
                    Download again
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              This list lives on this device only. Downloading again rebuilds the
              file from current attendance, so it may differ from the original if
              the register has changed since.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
