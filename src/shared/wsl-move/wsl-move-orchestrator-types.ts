/**
 * The general migration's orchestrator (D3a): per distro, when to start the move the driver runs,
 * and what the user is told while it cannot finish. It never boots a distro (A1): only a user
 * action that already woke it, or an explicit request, starts anything.
 */
import type { WslMoveBlocker } from './wsl-move-driver-types'

/** What woke the orchestrator for a distro. */
export type WslMoveOrchestratorTrigger =
  /** The distro's host connection reached ready (the user's Connect, or visible demand, C7). */
  | 'connect'
  /** The user opened a project of a distro that is already running. */
  | 'project-opened'
  /** App start, for a distro whose host is already ready. */
  | 'startup'
  /** Retry or Restore from the distro's status line. */
  | 'user'
  /** A backoff retry or deferred re-check; runs only while the host stays ready. */
  | 'timer'

/** "Use on this computer again" (`released-here`) or a Remove of the distro's host (`removed`). */
export type WslMoveOrchestratorDeclineCause = 'released-here' | 'removed'

/** Why the orchestrator stopped trying on its own; each needs the user. */
export type WslMoveOrchestratorParkReason =
  | 'export-incomplete'
  | 'manifest-too-large'
  | 'host-update-required'
  | 'attempts-exhausted'
  /** The user cancelled a move or chose "Not now"; it lapses after a week. */
  | 'not-now'
  /** The user brought the projects back with "Use on this computer again"; only Retry undoes it. */
  | 'declined'
  /** The user's Remove of the host could not prove its server stopped (E11); nothing touches it. */
  | 'removal-pending'
  /** An earlier move never finished settling for a day; the waits stopped and need the user. */
  | 'stuck'

export type WslMoveOrchestratorState =
  /** Nothing of the distro left to move. */
  | { kind: 'idle' }
  /** Waiting for a trigger. */
  | { kind: 'pending' }
  /** "Finishing your move": the move waits on busy terminals, automations or dispatches. */
  /** `rechecks` counts timer re-checks; after the last one, only a user action or wake re-checks. */
  | { kind: 'deferred'; blockers: WslMoveBlocker[]; rechecks: number }
  | { kind: 'moving' }
  /** The move may have reached the host; it resumes when the host answers. */
  | { kind: 'waiting-for-host'; migrationId: string }
  /** `waits`: uncounted checks so far (an earlier move still settling), for their cap. */
  | { kind: 'backoff'; nextAttemptAt: number; reason: string; waits?: number }
  | {
      kind: 'parked'
      reason: WslMoveOrchestratorParkReason
      until?: number
      /** For `declined`: which choice of the user's declined it. */
      cause?: WslMoveOrchestratorDeclineCause
    }
  /**
   * `nextCheckAt` / `waits` while a newer preview waits on this move to finish settling:
   * new projects may be queued behind it, so the wait is re-checked and capped like a backoff.
   */
  | { kind: 'done'; migrationId: string; nextCheckAt?: number; waits?: number }
  /** R38: a finished move's distro is registered under neither its name nor its recorded GUID. */
  | { kind: 'distro-gone' }
  /** R38: the distro was replaced (new GUID) or its host lost the moved projects. */
  | { kind: 'restore-offered' }

export type WslMoveOrchestratorStateKind = WslMoveOrchestratorState['kind']

/** One distro's persisted record. */
export type WslMoveOrchestratorRecord = {
  distro: string
  state: WslMoveOrchestratorState
  /** Failed automatic attempts since the last success or user Retry. */
  attempts: number
  /** The build that counted `attempts`; a new build may try again. */
  appVersion: string
  updatedAt: number
}

/** What the user asked of a distro's move from its status line. */
export type WslMoveOrchestratorUserAction = 'retry' | 'not-now' | 'restore'

export const WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL = 'wslMoveOrchestrator:status'
/** Main asks the window for its slept-pane bindings before an automatic start. */
export const WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL =
  'wslMoveOrchestrator:requestSleptPanes'
