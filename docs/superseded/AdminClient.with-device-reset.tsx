"use client";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { deviceId } from "@/lib/device";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controls } from "./Controls";
import { QrPanel } from "./QrPanel";

type Student = {
  studentId: string;
  sNo: number;
  rollNo: string;
  name: string;
  enrolled: boolean;
  markedAt: string | null;
  source: "scan" | "manual" | null;
  isSelf: boolean;
};

type Session = {
  id: string;
  classDate: string;
  isOpen: boolean;
  openedAt: string;
  expiresAt: string;
  scannable: boolean;
  windowSeconds: number;
};

type Roster = {
  session: Session | null;
  students: Student[];
  markedCount: number;
  total: number;
  sessions: { id: string; classDate: string; isOpen: boolean }[];
  today: string;
  role: "primary" | "deputy";
  deputyLabel: string | null;
  deputyExpiresAt: string | null;
};

const POLL_MS = 5000;

function formatDate(d: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${d}T00:00:00Z`));
}

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function countdown(expiresAt: string, now: number) {
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AdminClient() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** Students tapped but not yet written. Purely local until Save. */
  const [staged, setStaged] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  /** A scanned student awaiting confirmation before their mark is removed. */
  const [confirmUnmark, setConfirmUnmark] = useState<Student | null>(null);
  /** Rows with an in-flight toggle; their optimistic state must survive a poll. */
  const pending = useRef<Set<string>>(new Set());

  const load = useCallback(async (sessionId?: string | null) => {
    /*
     * Two attempts. If the selected session has vanished — deleted, or the term
     * reset from elsewhere — retry against the current session within this same
     * call. Previously the poll just returned on any non-OK status, so the grid
     * kept showing a roster with nothing behind it and every tap came back
     * "did not save". Retrying here rather than writing `selectedId` keeps the
     * fix out of the polling effect's own dependencies.
     */
    let target = sessionId ?? null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const qs = target ? `?s=${encodeURIComponent(target)}` : "";
      const res = await fetch(`/api/roster${qs}`, { cache: "no-store" });
      if (res.status === 401) {
        window.location.reload(); // cookie expired mid-class
        return;
      }
      if (res.status === 404 && target) {
        setNotice("That session no longer exists. Showing the current one.");
        target = null;
        continue;
      }
      if (!res.ok) return;
      const data: Roster = await res.json();
      setRoster((prev) => {
        if (!prev || pending.current.size === 0) return data;
        // Keep optimistic rows as they are until their request settles.
        return {
          ...data,
          students: data.students.map((s) => {
            if (!pending.current.has(s.studentId)) return s;
            return prev.students.find((p) => p.studentId === s.studentId) ?? s;
          }),
        };
      });
      return;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Kicked off inside an async scope so no state write happens synchronously
    // in the effect body; the interval callback runs outside it either way.
    (async () => {
      if (!cancelled) await load(selectedId);
    })();
    const id = setInterval(() => void load(selectedId), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, selectedId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const session = roster?.session ?? null;
  const marked = useMemo(
    () => roster?.students.filter((s) => s.markedAt) ?? [],
    [roster],
  );
  const unmarked = useMemo(
    () => roster?.students.filter((s) => !s.markedAt) ?? [],
    [roster],
  );
  const markedCount = marked.length;
  /*
   * Staged ids that are still actually unmarked. Derived rather than pruned in
   * an effect: if a student scans while staged they simply drop out here, so a
   * scan is never overwritten by a manual mark and nothing has to be kept in
   * sync.
   */
  const pendingIds = useMemo(() => {
    const open = new Set(unmarked.map((s) => s.studentId));
    return [...staged].filter((id) => open.has(id));
  }, [staged, unmarked]);
  const filteredUnmarked = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return unmarked;
    return unmarked.filter(
      (s) =>
        s.name.toLowerCase().includes(q) || s.rollNo.toLowerCase().includes(q),
    );
  }, [unmarked, query]);
  const allVisibleStaged = useMemo(
    () =>
      filteredUnmarked.length > 0 &&
      filteredUnmarked.every((s) => staged.has(s.studentId)),
    [filteredUnmarked, staged],
  );

  /**
   * Stages or clears everyone currently visible in the unmarked list.
   *
   * Deliberately scoped to the filtered view rather than the whole roster: if
   * the admin has typed a search, "select all" that quietly staged 40 hidden
   * students would be a trap.
   */
  function toggleSelectAllVisible() {
    const visible = filteredUnmarked.map((s) => s.studentId);
    const allStaged =
      visible.length > 0 && visible.every((id) => staged.has(id));
    setStaged((prev) => {
      const next = new Set(prev);
      for (const id of visible) {
        if (allStaged) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  /** Tapping an unmarked row only changes local state — no request, no wait. */
  function stage(studentId: string) {
    setStaged((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  async function post(url: string, body: object) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    } catch {
      setNotice("No connection.");
      return { ok: false, data: {} as Record<string, unknown> };
    } finally {
      setBusy(false);
    }
  }

  async function startSession(opts: {
    classDate?: string;
    durationMinutes: number;
    windowSeconds: number;
  }) {
    const { ok, data } = await post("/api/sessions", opts);
    if (ok) {
      const created = (data as { session: Session }).session;
      setSelectedId(created.id);
      await load(created.id);
      return;
    }
    const err = data as { error?: string; session?: Session };
    if (err.error === "DATE_HAS_SESSION" && err.session) {
      // The intent is "get me to that day's grid", so go there.
      setNotice(
        `${formatDate(err.session.classDate)} already has a session — opened it.`,
      );
      setSelectedId(err.session.id);
      await load(err.session.id);
    } else if (err.error === "FUTURE_DATE") {
      setNotice("That date is in the future.");
    } else if (err.error === "BAD_DATE") {
      setNotice("Pick a valid date.");
    } else if (err.error === "BAD_DURATION") {
      setNotice("Pick a duration between 1 minute and 10 hours.");
    } else if (err.error === "BAD_WINDOW") {
      setNotice("QR rotation must be between 5 and 300 seconds.");
    } else {
      setNotice("Could not start a session.");
    }
  }

  async function setSessionOpen(
    open: boolean,
    opts: { minutes?: number; windowSeconds?: number } = {},
  ) {
    if (!session) return;
    const { ok, data } = await post("/api/sessions/state", {
      sessionId: session.id,
      open,
      ...opts,
    });
    if (!ok) {
      const err = (data as { error?: string }).error;
      setNotice(
        err === "NOT_TODAY"
          ? "Only today's session can be resumed."
          : err === "BAD_DURATION"
            ? "Pick a duration between 1 minute and 10 hours."
            : err === "BAD_WINDOW"
              ? "QR rotation must be between 5 and 300 seconds."
              : "Could not change the session.",
      );
      return;
    }
    const result = data as { session: Session; extended: boolean };
    if (!open) {
      setShowQr(false);
      setNotice("Session stopped. You can still tap the grid.");
    } else if (opts.minutes) {
      setNotice(
        result.extended
          ? `Extended by ${opts.minutes} min.`
          : `Session running for ${opts.minutes} min.`,
      );
    } else if (opts.windowSeconds) {
      setNotice(`QR now rotates every ${opts.windowSeconds} seconds.`);
    }
    await load(session.id);
  }

  /**
   * Links this phone to the admin's own student record.
   *
   * An admin with a single device cannot scan a QR their own screen is showing,
   * so this is the way in. The server decides which student it binds, from
   * ADMIN_ROLL_NO.
   */
  async function claimThisDevice() {
    setMenuFor(null);
    const { ok, data } = await post("/api/admin/claim-device", {
      deviceId: deviceId(),
    });
    const err = (data as { error?: string; name?: string }).error;
    setNotice(
      ok
        ? (data as { status: string; name: string }).status === "ALREADY_LINKED"
          ? "This phone is already linked to you."
          : `This phone is now linked to you. Scanning will mark you present.`
        : err === "NO_ADMIN_ROLL"
          ? "Set ADMIN_ROLL_NO to your roll number first."
          : err === "DEVICE_ALREADY_BOUND"
            ? `This phone already belongs to ${(data as { name?: string }).name ?? "another student"}.`
            : "Could not link this phone.",
    );
    if (ok) await load(selectedId);
  }

  /**
   * Writes every staged student in one request.
   *
   * The endpoint only inserts, so saving twice is harmless and a student who
   * scanned in the meantime keeps their scan rather than being overwritten.
   */
  async function saveStaged(reason?: string) {
    if (!session || pendingIds.length === 0) return;
    setSaving(true);
    try {
      const { ok, data } = await post("/api/marks", {
        sessionId: session.id,
        studentIds: pendingIds,
        reason,
      });
      if (!ok) {
        const err = (data as { error?: string }).error;
        setNotice(
          err === "NO_SESSION"
            ? "That session no longer exists. Nothing was saved."
            : "Could not save. Your taps are still here — try again.",
        );
        return;
      }
      const { saved, alreadyMarked } = data as {
        saved: number;
        alreadyMarked: number;
      };
      setStaged(new Set());
      setNotice(
        alreadyMarked > 0
          ? `Saved ${saved}. ${alreadyMarked} had already scanned.`
          : `Saved ${saved} ${saved === 1 ? "mark" : "marks"}.`,
      );
      await load(selectedId);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Removing a mark is deliberate, one at a time.
   *
   * A student who scanned in produced their own evidence of being there, so
   * erasing it asks first and names who and when. A mark the admin made by hand
   * is theirs to undo, and goes straight through.
   */
  function requestUnmark(student: Student) {
    setMenuFor(null);
    if (student.source === "scan") setConfirmUnmark(student);
    else void unmark(student);
  }

  async function unmark(student: Student) {
    setConfirmUnmark(null);
    if (!session) return;
    const { ok } = await post("/api/marks/remove", {
      sessionId: session.id,
      studentId: student.studentId,
    });
    setNotice(
      ok
        ? `${student.name} is no longer marked present.`
        : "Could not remove that mark.",
    );
    if (ok) await load(selectedId);
  }

  async function resetDevice(student: Student) {
    setMenuFor(null);
    const { ok } = await post("/api/reset-device", {
      studentId: student.studentId,
    });
    setNotice(
      ok
        ? `${student.name} can register a new phone on the next scan.`
        : "Could not reset that device.",
    );
    if (ok) await load(selectedId);
  }

  if (!roster) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Spinner label="Loading roster…" />
      </main>
    );
  }

  const live = session?.scannable ?? false;

  return (
    <main className="mx-auto max-w-3xl pb-24">
      <ConfirmDialog
        open={confirmUnmark !== null}
        title="Remove this student's own scan?"
        confirmLabel="Remove the mark"
        cancelLabel="Keep it"
        busy={busy}
        onCancel={() => setConfirmUnmark(null)}
        onConfirm={() => void unmark(confirmUnmark as Student)}
      >
        {confirmUnmark && (
          <>
            <p>
              <strong className="font-medium text-slate-900 dark:text-slate-100">
                {confirmUnmark.name}
              </strong>{" "}
              ({confirmUnmark.rollNo}) scanned themselves in at{" "}
              {formatTime(confirmUnmark.markedAt as string)}.
            </p>
            <p className="mt-2">
              Removing it marks them absent for this class. Only do this if you
              know they were not here.
            </p>
          </>
        )}
      </ConfirmDialog>

      {showQr && session && live && (
        <QrPanel
          sessionId={session.id}
          fullscreen
          onClose={() => setShowQr(false)}
        />
      )}

      <header className="sticky top-0 z-20 border-b border-slate-200 bg-[var(--background)]/95 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur dark:border-slate-800">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="min-w-0 truncate text-lg font-semibold">
            Soft Skills
            {session && (
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {formatDate(session.classDate)}
              </span>
            )}
          </h1>
          <p className="shrink-0 text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {markedCount} / {roster.total} marked
          </p>
        </div>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          {!session ? (
            "No session yet"
          ) : live ? (
            <span className="text-emerald-700 dark:text-emerald-400">
              Session live · {countdown(session.expiresAt, now)} remaining · QR
              every {session.windowSeconds}s
            </span>
          ) : session.isOpen ? (
            "Session expired"
          ) : (
            "Session closed — taps still recorded"
          )}
        </p>
      </header>

      {roster.role === "deputy" && (
        <div className="mx-4 mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm ring-1 ring-amber-500/30 dark:bg-amber-950/40">
          <p className="font-medium">
            Temporary access as {roster.deputyLabel}
          </p>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
            You can run the class and download a view-only sheet.
            {roster.deputyExpiresAt
              ? ` Access ends ${new Intl.DateTimeFormat("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(new Date(roster.deputyExpiresAt))}.`
              : ""}
          </p>
        </div>
      )}

      {notice && (
        <div
          role="status"
          className="mx-4 mt-3 flex items-start gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm ring-1 ring-amber-500/30 dark:bg-amber-950/40"
        >
          <span className="flex-1">{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400"
          >
            Dismiss
          </button>
        </div>
      )}

      <Controls
        isPrimary={roster.role === "primary"}
        students={roster.students}
        sessions={roster.sessions}
        today={roster.today}
        session={session}
        live={live}
        busy={busy}
        selectedId={selectedId ?? session?.id ?? null}
        onSelect={(id) => {
          setSelectedId(id);
        }}
        onStart={startSession}
        onShowQr={() => setShowQr(true)}
        onSetOpen={setSessionOpen}
        onRosterChanged={async (message) => {
          setNotice(message);
          await load(selectedId);
        }}
      />

      {!session && (
        <p className="px-4 pt-4 text-sm text-slate-500 dark:text-slate-400">
          Start a session to take attendance. The roster below is read-only
          until you do.
        </p>
      )}

      {/* Present already: scanned, or saved by hand. Not tappable, so a stray
          thumb cannot absent somebody who did turn up. */}
      <section className="mt-4">
        <h2 className="px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Marked · {marked.length}
        </h2>
        {marked.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Nobody yet. Scans appear here on their own.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {marked.map((s) => (
              <li key={s.studentId}>
                <div className="flex items-stretch">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 sm:gap-3 sm:px-4">
                    <span
                      aria-hidden
                      className="w-4 shrink-0 text-center text-emerald-700 dark:text-emerald-400"
                    >
                      {s.source === "manual" ? "✎" : "✓"}
                    </span>
                    <span className="w-24 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.rollNo}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                      <span className="truncate">{s.name}</span>
                      {s.isSelf && <SelfBadge />}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                      {s.source === "manual"
                        ? "manual"
                        : formatTime(s.markedAt as string)}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      setMenuFor(menuFor === s.studentId ? null : s.studentId)
                    }
                    aria-label={`More actions for ${s.name}`}
                    className="tap-square shrink-0 px-3 text-slate-500 dark:text-slate-400"
                  >
                    ⋯
                  </button>
                </div>
                {menuFor === s.studentId && (
                  <RowMenu
                    student={s}
                    role={roster.role}
                    busy={busy}
                    onClose={() => setMenuFor(null)}
                    onReset={() => void resetDevice(s)}
                    onClaim={() => void claimThisDevice()}
                    onUnmark={() => requestUnmark(s)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Not marked yet: tapping stages locally and costs nothing. */}
      <section className="mt-6">
        <div className="flex items-baseline justify-between gap-3 px-4 pb-1">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Not marked · {unmarked.length}
          </h2>
          {pendingIds.length > 0 && (
            <span className="text-xs text-amber-700 dark:text-amber-400">
              {pendingIds.length} waiting to save
            </span>
          )}
        </div>

        {unmarked.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
            {unmarked.length > 3 && (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or roll number"
                aria-label="Filter unmarked students"
                autoCapitalize="none"
                spellCheck={false}
                className="min-w-40 flex-1 rounded-xl border border-slate-300 bg-transparent px-3 py-2 text-base dark:border-slate-700"
              />
            )}
            {filteredUnmarked.length > 0 && (
              <button
                onClick={toggleSelectAllVisible}
                disabled={!session}
                className="min-h-11 shrink-0 rounded-xl border border-slate-300 px-3 text-sm disabled:opacity-40 dark:border-slate-700"
              >
                {allVisibleStaged
                  ? "Clear selection"
                  : query.trim()
                    ? `Select all ${filteredUnmarked.length} shown`
                    : `Select all ${filteredUnmarked.length}`}
              </button>
            )}
          </div>
        )}

        {unmarked.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Everyone is marked.
          </p>
        ) : filteredUnmarked.length === 0 ? (
          <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">
            Nobody unmarked matches “{query}”.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 border-y border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {filteredUnmarked.map((s) => {
              const isStaged = staged.has(s.studentId);
              return (
                <li key={s.studentId}>
                  <div className="flex items-stretch">
                    <button
                      onClick={() => stage(s.studentId)}
                      disabled={!session}
                      aria-pressed={isStaged}
                      className={`flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 text-left enabled:active:bg-slate-100 sm:gap-3 sm:px-4 dark:enabled:active:bg-slate-800 ${
                        isStaged ? "bg-amber-50 dark:bg-amber-950/40" : ""
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`w-4 shrink-0 text-center ${
                          isStaged
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {isStaged ? "✎" : "·"}
                      </span>
                      <span className="w-24 shrink-0 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {s.rollNo}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                        <span className="truncate">{s.name}</span>
                        {s.isSelf && <SelfBadge />}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {isStaged ? "will save" : "—"}
                      </span>
                    </button>
                    <button
                      onClick={() =>
                        setMenuFor(menuFor === s.studentId ? null : s.studentId)
                      }
                      aria-label={`More actions for ${s.name}`}
                      className="tap-square shrink-0 px-3 text-slate-500 dark:text-slate-400"
                    >
                      ⋯
                    </button>
                  </div>
                  {menuFor === s.studentId && (
                    <RowMenu
                      student={s}
                      role={roster.role}
                      busy={busy}
                      onClose={() => setMenuFor(null)}
                      onReset={() => void resetDevice(s)}
                      onClaim={() => void claimThisDevice()}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">
        ✓ scanned · ✎ marked by hand · · absent
      </p>

      {/* Only ever on screen when there is something to write. */}
      {pendingIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-[var(--background)]/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur dark:border-slate-800">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <button
              onClick={() => setStaged(new Set())}
              disabled={saving}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm disabled:opacity-40 dark:border-slate-700"
            >
              Discard
            </button>
            <button
              onClick={() => void saveStaged()}
              disabled={saving}
              className="flex-1 rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {saving
                ? "Saving…"
                : `Save ${pendingIds.length} ${pendingIds.length === 1 ? "mark" : "marks"}`}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/** Marks the admin's own row, so they can find themselves among 47. */
function SelfBadge() {
  return (
    <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-200">
      YOU
    </span>
  );
}

/**
 * The per-row overflow menu.
 *
 * Unmarking lives here rather than on the row itself: it is the one action that
 * can wrongly absent a student who did turn up, so it should take a deliberate
 * second tap. `onUnmark` is only passed for rows that are actually marked.
 */
function RowMenu({
  student,
  role,
  busy,
  onClose,
  onReset,
  onClaim,
  onUnmark,
}: {
  student: Student;
  role: "primary" | "deputy";
  busy: boolean;
  onClose: () => void;
  onReset: () => void;
  onClaim: () => void;
  onUnmark?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-4 py-3 pl-11 text-sm dark:bg-slate-900">
      {onUnmark && (
        <button
          onClick={onUnmark}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
        >
          Unmark
        </button>
      )}
      <span className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400">
        {student.enrolled ? "Phone registered" : "No phone registered"}
      </span>
      {role === "primary" ? (
        <button
          onClick={onReset}
          disabled={busy || !student.enrolled}
          className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
        >
          Reset device
        </button>
      ) : (
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Only the admin can reset a device.
        </span>
      )}
      {student.isSelf && role === "primary" && (
        <button
          onClick={onClaim}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
        >
          {student.enrolled ? "Re-link this phone" : "Register this phone"}
        </button>
      )}
      <button
        onClick={onClose}
        className="inline-flex min-h-11 items-center px-1 text-slate-500 dark:text-slate-400"
      >
        Close
      </button>
    </div>
  );
}
