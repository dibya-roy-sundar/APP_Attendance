"use client";

import { ThemeToggle } from "@/components/ThemeToggle";
import { useState } from "react";
import { AccessPanel } from "./AccessPanel";
import { AddStudentPanel } from "./AddStudentPanel";
import { ExportPanel } from "./ExportPanel";
import {
  DEFAULT_DURATION,
  DEFAULT_ROTATION,
  LiveSessionControls,
  SessionSetup,
} from "./SessionSetup";

type Session = {
  id: string;
  classDate: string;
  isOpen: boolean;
  openedAt: string;
  expiresAt: string;
  scannable: boolean;
  windowSeconds: number;
};

type Props = {
  /** The roster, so temporary access can only be granted to someone on it. */
  students: { studentId: string; rollNo: string; name: string }[];
  sessions: { id: string; classDate: string; isOpen: boolean }[];
  enrollmentOpen: boolean;
  session: Session | null;
  live: boolean;
  busy: boolean;
  selectedId: string | null;
  today: string;
  /** Deputies run the class but never touch identity settings. */
  isPrimary: boolean;
  onSelect: (id: string) => void;
  onStart: (opts: {
    classDate?: string;
    durationMinutes: number;
    windowSeconds: number;
  }) => void;
  onShowQr: () => void;
  onSetOpen: (
    open: boolean,
    opts?: { minutes?: number; windowSeconds?: number },
  ) => void;
  onToggleEnrollment: () => void;
  onRosterChanged: (message: string) => void;
};

function formatDate(d: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(`${d}T00:00:00Z`));
}

/**
 * Everything that is not the grid. Show QR is the prominent action because the
 * grid is the default view and the QR is the thing you open, not the reverse.
 */
export function Controls({
  students,
  sessions,
  enrollmentOpen,
  session,
  live,
  busy,
  selectedId,
  today,
  isPrimary,
  onSelect,
  onStart,
  onShowQr,
  onSetOpen,
  onToggleEnrollment,
  onRosterChanged,
}: Props) {
  const [panel, setPanel] = useState<
    "none" | "start" | "live" | "more" | "export" | "access" | "students"
  >("none");
  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [rotation, setRotation] = useState(DEFAULT_ROTATION);
  const [backdate, setBackdate] = useState("");
  const todaySession = sessions.find((s) => s.classDate === today);
  const toggle = (
    p: "start" | "live" | "more" | "export" | "access" | "students",
  ) => setPanel((v) => (v === p ? "none" : p));

  return (
    <section className="px-4 pt-3">
      <div className="flex flex-wrap gap-2">
        {live && session ? (
          <>
            <button
              onClick={onShowQr}
              className="rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white dark:bg-white dark:text-slate-900"
            >
              Show QR
            </button>
            <button
              onClick={() => toggle("live")}
              aria-expanded={panel === "live"}
              className="rounded-xl border border-slate-300 px-4 py-2.5 dark:border-slate-700"
            >
              Extend / stop
            </button>
          </>
        ) : todaySession && session?.classDate === today ? (
          <button
            onClick={() => toggle("start")}
            aria-expanded={panel === "start"}
            className="rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white dark:bg-white dark:text-slate-900"
          >
            Resume session
          </button>
        ) : todaySession ? (
          <button
            onClick={() => onSelect(todaySession.id)}
            disabled={busy}
            className="rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            Go to today
          </button>
        ) : (
          <button
            onClick={() => toggle("start")}
            aria-expanded={panel === "start"}
            className="rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white dark:bg-white dark:text-slate-900"
          >
            Start session
          </button>
        )}

        {sessions.length > 0 && (
          <select
            value={selectedId ?? ""}
            onChange={(e) => onSelect(e.target.value)}
            aria-label="Class date"
            className="rounded-xl border border-slate-300 bg-transparent px-3 py-2.5 dark:border-slate-700"
          >
            {[...sessions]
              .sort((a, b) => b.classDate.localeCompare(a.classDate))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {formatDate(s.classDate)}
                  {s.classDate === today ? " (today)" : ""}
                </option>
              ))}
          </select>
        )}

        <button
          onClick={() => toggle("export")}
          aria-expanded={panel === "export"}
          className="rounded-xl border border-slate-300 px-4 py-2.5 dark:border-slate-700"
        >
          Download .xlsx
        </button>

        <button
          onClick={() => toggle("more")}
          aria-expanded={panel === "more"}
          className="rounded-xl border border-slate-300 px-4 py-2.5 dark:border-slate-700"
        >
          More
        </button>
      </div>

      {/* Start / resume: pick the duration and rotation before committing. */}
      {panel === "start" && (
        <Panel>
          <SessionSetup
            duration={duration}
            rotation={rotation}
            onDuration={setDuration}
            onRotation={setRotation}
            disabled={busy}
          />
          <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
            <button
              onClick={() => {
                setPanel("none");
                if (todaySession && session?.classDate === today) {
                  onSetOpen(true, {
                    minutes: duration,
                    windowSeconds: rotation,
                  });
                } else {
                  onStart({
                    durationMinutes: duration,
                    windowSeconds: rotation,
                  });
                }
              }}
              disabled={busy}
              className="rounded-xl bg-slate-900 px-4 py-2.5 font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
            >
              {todaySession && session?.classDate === today
                ? `Resume for ${duration} min`
                : `Start for ${duration} min`}
            </button>
          </div>
        </Panel>
      )}

      {/* Running session: extend, retune the rotation, or stop early. */}
      {panel === "live" && session && (
        <Panel>
          <LiveSessionControls
            rotation={session.windowSeconds}
            busy={busy}
            onExtend={(minutes) => onSetOpen(true, { minutes })}
            onRotation={(windowSeconds) => onSetOpen(true, { windowSeconds })}
            onStop={() => {
              setPanel("none");
              onSetOpen(false);
            }}
          />
        </Panel>
      )}

      {panel === "export" && (
        <Panel>
          <ExportPanel today={today} viewOnly={!isPrimary} />
        </Panel>
      )}

      {panel === "students" && (
        <Panel>
          <AddStudentPanel
            onAdded={(message) => {
              setPanel("none");
              onRosterChanged(message);
            }}
          />
        </Panel>
      )}

      {panel === "access" && (
        <Panel>
          <AccessPanel students={students} />
        </Panel>
      )}

      {panel === "more" && (
        <Panel>
          {isPrimary && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">
                Registration window
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Students can claim a roll number only while this is open.
                </span>
              </span>
              <button
                onClick={onToggleEnrollment}
                disabled={busy}
                aria-pressed={enrollmentOpen}
                aria-label={`${enrollmentOpen ? "Open" : "Closed"} — registration window`}
                className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium disabled:opacity-40 ${
                  enrollmentOpen
                    ? "bg-emerald-700 text-white"
                    : "border border-slate-300 dark:border-slate-700"
                }`}
              >
                {enrollmentOpen ? "Open" : "Closed"}
              </button>
            </div>
          )}

          {isPrimary && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <span className="text-sm">
                Roster
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Add a student who joined late.
                </span>
              </span>
              <button
                onClick={() => toggle("students")}
                className="min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-sm dark:border-slate-700"
              >
                Add student
              </button>
            </div>
          )}

          {isPrimary && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
              <span className="text-sm">
                Temporary access
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  Let someone cover a class while you are away.
                </span>
              </span>
              <button
                onClick={() => toggle("access")}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
              >
                Manage
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
            <label className="flex-1">
              <span className="block text-sm">Session for a past date</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400">
                No QR is generated. Tap the grid from memory or a paper list.
              </span>
              <input
                type="date"
                max={today}
                value={backdate}
                onChange={(e) => setBackdate(e.target.value)}
                className="mt-2 rounded-lg border border-slate-300 bg-transparent px-3 py-1.5 text-base dark:border-slate-700"
              />
            </label>
            <button
              onClick={() => {
                if (!backdate) return;
                setPanel("none");
                onStart({
                  classDate: backdate,
                  durationMinutes: duration,
                  windowSeconds: rotation,
                });
                setBackdate("");
              }}
              disabled={busy || !backdate}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-700"
            >
              Create
            </button>
          </div>

          <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
            <p className="text-sm font-medium">Appearance</p>
            <div className="mt-2">
              <ThemeToggle />
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/admin/logout", { method: "POST" });
                window.location.reload();
              }}
              className="inline-flex min-h-11 items-center text-sm text-slate-500 dark:text-slate-400 underline"
            >
              Sign out
            </button>
          </div>
        </Panel>
      )}
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-xl bg-white p-4 ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
      {children}
    </div>
  );
}
