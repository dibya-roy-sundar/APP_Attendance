'use client'

import { useEffect, useRef } from 'react'

/**
 * A confirmation dialog for the one action that can wrongly absent a student.
 *
 * Built by hand rather than with `<dialog>`: Safari only gained `showModal`
 * recently and its backdrop still behaves differently from Chrome's, so a plain
 * fixed overlay is the thing that renders identically on both. Sized in `dvh`
 * so the mobile browser chrome cannot clip it, and padded for the notch and the
 * home indicator.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    // Cancel takes focus, not confirm: a stray Enter should do nothing.
    cancelRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)

    // Stop the roster scrolling behind the dialog on both platforms.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:items-center"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        // Clicking the card must not fall through to the backdrop's dismiss.
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85dvh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-xl ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10"
      >
        <h2 id="confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{children}</div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-medium disabled:opacity-40 dark:border-slate-700"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-11 rounded-xl bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-40 dark:bg-red-600"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
