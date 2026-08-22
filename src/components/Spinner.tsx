export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-slate-500 dark:text-slate-400">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
      />
      {label ? <span className="text-sm">{label}</span> : null}
    </div>
  )
}
