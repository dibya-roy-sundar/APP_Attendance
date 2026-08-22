'use client'

import { useState } from 'react'

const DURATIONS = [15, 30, 45, 60, 90, 120] as const
const ROTATIONS = [10, 15, 30, 60, 120] as const

export const DEFAULT_DURATION = 30
export const DEFAULT_ROTATION = 15

/**
 * The two choices the admin makes when starting a class: how long attendance
 * stays open, and how fast the QR rotates.
 *
 * Presets rather than free text, because both have a range where they work and a
 * mistyped digit is the difference between a 30-minute window and a 30-hour one.
 */
export function SessionSetup({
  duration,
  rotation,
  onDuration,
  onRotation,
  disabled,
  compact,
}: {
  duration: number
  rotation: number
  onDuration: (v: number) => void
  onRotation: (v: number) => void
  disabled?: boolean
  compact?: boolean
}) {
  return (
    <div className={compact ? 'flex flex-wrap gap-4' : 'flex flex-col gap-4'}>
      <Choice
        label="Open for"
        hint="How long students can scan"
        value={duration}
        options={DURATIONS.map((m) => ({ value: m, label: m >= 60 ? `${m / 60} hr` : `${m} min` }))}
        onChange={onDuration}
        disabled={disabled}
      />
      <Choice
        label="QR rotates every"
        hint="Shorter is harder to forward, longer is easier to scan"
        value={rotation}
        options={ROTATIONS.map((s) => ({ value: s, label: `${s} s` }))}
        onChange={onRotation}
        disabled={disabled}
      />
    </div>
  )
}

function Choice({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  value: number
  options: { value: number; label: string }[]
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0" disabled={disabled}>
      <legend className="text-sm font-medium">{label}</legend>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={value === o.value}
            className={`rounded-lg px-3 py-1.5 text-sm tabular-nums disabled:opacity-40 ${
              value === o.value
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'border border-slate-300 dark:border-slate-700'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

/** Extend a session that is already running, or stop it early. */
export function LiveSessionControls({
  onExtend,
  onStop,
  onRotation,
  rotation,
  busy,
}: {
  onExtend: (minutes: number) => void
  onStop: () => void
  onRotation: (seconds: number) => void
  rotation: number
  busy?: boolean
}) {
  const [pendingRotation, setPendingRotation] = useState(rotation)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium">Extend</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Added to the current end time, so extending twice adds twice.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[5, 10, 15, 30].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onExtend(m)}
              disabled={busy}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm tabular-nums disabled:opacity-40 dark:border-slate-700"
            >
              +{m} min
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm font-medium">QR rotation</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Changing this refreshes the projected code within one old period.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {ROTATIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setPendingRotation(s)
                onRotation(s)
              }}
              aria-pressed={pendingRotation === s}
              disabled={busy}
              className={`rounded-lg px-3 py-1.5 text-sm tabular-nums disabled:opacity-40 ${
                pendingRotation === s
                  ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                  : 'border border-slate-300 dark:border-slate-700'
              }`}
            >
              {s} s
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <span className="text-sm">
          Stop now
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Ends the QR immediately. Taps on the grid keep working.
          </span>
        </span>
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
        >
          Stop session
        </button>
      </div>
    </div>
  )
}
