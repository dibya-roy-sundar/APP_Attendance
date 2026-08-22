'use client'

import { DEFAULT_MODE, type ThemeMode, applyTheme, readMode } from '@/lib/theme'
import { useEffect, useSyncExternalStore } from 'react'

const OPTIONS: { mode: ThemeMode; label: string; glyph: string }[] = [
  { mode: 'light', label: 'Light', glyph: '☀' },
  { mode: 'dark', label: 'Dark', glyph: '☾' },
  { mode: 'system', label: 'Auto', glyph: '◐' },
]

const CHANGED = 'att:theme-changed'

/**
 * The chosen mode lives in localStorage, which is an external store — so it is
 * read through useSyncExternalStore rather than copied into state by an effect.
 * That also makes a change in one tab show up in the others.
 */
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** Light / Dark / Auto, where Auto tracks the phone's own setting. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const mode = useSyncExternalStore(subscribe, readMode, () => DEFAULT_MODE)

  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    // Keep following the device if its setting changes mid-session.
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  function choose(next: ThemeMode) {
    applyTheme(next)
    window.dispatchEvent(new Event(CHANGED))
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className={`inline-flex rounded-xl border border-slate-300 p-0.5 dark:border-slate-700 ${
        compact ? '' : 'w-full justify-between'
      }`}
    >
      {OPTIONS.map((o) => {
        const active = mode === o.mode
        return (
          <button
            key={o.mode}
            type="button"
            onClick={() => choose(o.mode)}
            aria-pressed={active}
            title={o.label}
            className={`flex min-w-11 flex-1 items-center justify-center gap-1.5 rounded-[0.6rem] px-3 text-sm ${
              active
                ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <span aria-hidden>{o.glyph}</span>
            <span className={compact ? 'sr-only' : ''}>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
