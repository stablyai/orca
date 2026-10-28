/**
 * The IPC contract of a "move projects to the WSL host" run, for the move dialog. Main runs
 * the move; the renderer previews it, starts it, may cancel it before the switch, and follows its
 * progress. Every call refuses with `wsl_move_unavailable` while the internal WSL hosts gate is off.
 */
import type { WslMoveCutoverPhase } from './wsl-move-cutover'

/** Which projects of a distro to move; omitted ids mean every project in the distro. */
export type WslMoveRequest = {
  distro: string
  repoIds?: string[]
  folderWorkspaceIds?: string[]
  /** The window's bindings of panes with no live terminal: main retires a slept pane's on Sleep. */
  sleptPanes?: { paneKey: string; sessionId: string }[]
}

export type WslMoveRowRef = { kind: 'repo' | 'folder'; id: string }

export type WslMoveBlockerKind =
  | 'agent-working'
  | 'process-running'
  | 'agent-not-resumable'
  | 'unverifiable'
  | 'automation-running'
  | 'dispatch-running'
  | 'scrollback-too-large'

export type WslMoveBlockerAction = 'wait' | 'end' | 'skip-project' | 'clear-scrollback'

/** One reason the move cannot start now, with the ids it names (pane keys, run or dispatch ids). */
export type WslMoveBlocker = {
  kind: WslMoveBlockerKind
  ids: string[]
  actions: WslMoveBlockerAction[]
}

export type WslMoveRefusalCode =
  /** The internal WSL hosts gate is off. */
  | 'wsl_move_unavailable'
  /** This app is already moving projects into the distro. */
  | 'wsl_move_already_running'
  /** An earlier move of the distro has not finished; it resumes or resets first. */
  | 'wsl_move_already_in_flight'
  /** Every selected project is already on the host. */
  | 'wsl_move_nothing_new'
  /** The distro has no connected WSL host. */
  | 'wsl_move_host_unavailable'
  /** The host runs an older Orca that cannot take this move; it must update first. */
  | 'wsl_move_host_update_required'
  /** Terminals, automations or dispatches in scope must finish first: see `blockers`. */
  | 'wsl_move_terminals_blocked'
  /** Saved state the move cannot carry yet: see `reasons`. Nothing is dropped to make progress. */
  | 'wsl_move_export_incomplete'
  /** Too much saved state for one move; `message` says what to do. */
  | 'wsl_move_manifest_too_large'
  /** Pausing the terminals failed; `detail` names the step. */
  | 'wsl_move_pause_failed'
  /** A project in scope changed while it was paused; nothing moved. */
  | 'wsl_move_scope_changed'
  | 'wsl_move_cancelled'
  /**
   * An earlier move of the distro, interrupted after the host committed it, was finished first.
   * Reload the window as for `reloadRequired`, then start again.
   */
  | 'wsl_move_finished_earlier_move'

export type WslMovePreview =
  | {
      outcome: 'ready'
      distro: string
      repoIds: string[]
      folderWorkspaceIds: string[]
      /** Moved earlier and changed since by an older build: listed, not moved again. */
      changed: WslMoveRowRef[]
      /** On the host already with no move to show for it. */
      heldByHost: WslMoveRowRef[]
      /** Projects that touch the distro but cannot move, with the reason. */
      refused: { kind: 'repo' | 'folder-workspace'; id: string; reason: string }[]
      /** Empty when the move can start now. */
      blockers: WslMoveBlocker[]
    }
  | WslMoveRefusal

export type WslMoveRefusal = {
  outcome: 'refused'
  code: WslMoveRefusalCode
  /** User-facing, for `wsl_move_manifest_too_large`. */
  message?: string
  blockers?: WslMoveBlocker[]
  /** User-facing, for `wsl_move_export_incomplete`. */
  reasons?: string[]
  detail?: string
}

export type WslMoveResult =
  | {
      outcome: 'moved'
      migrationId: string
      phase: WslMoveCutoverPhase
      /**
       * This desktop's stores were rewritten under the open window: reload it through the
       * restart-preparation path (`requestLazyChunkRecoveryReload`), never a bare reload, so
       * unsaved editors are backed up and the session checkpoint lands first.
       */
      reloadRequired: true
      /**
       * Automations the host has not turned back on yet; Orca retries until it confirms. The
       * dialog must say they are off on the host for now, never hide it.
       */
      automationsPending?: string[]
      /** Set by the browser-login copy when the host's browser starts signed out. */
      browserLoginsNotCopiedReason?: string
    }
  | WslMoveRefusal
  | {
      /** The move stopped and was put back: nothing moved, the projects are usable here again. */
      outcome: 'reset'
      migrationId: string
      detail: string
    }
  | {
      /** It may have reached the host; the projects stay read-only until the host answers. */
      outcome: 'waiting-for-host'
      migrationId: string
      detail: string
    }

/** The dialog's stepper; `phase` is the journal's, once the move has one. */
export type WslMoveProgressStep =
  | 'preparing'
  | 'pausing-terminals'
  | 'copying'
  | 'switching'
  | 'finishing'
  | 'done'

export type WslMoveProgressEvent = {
  distro: string
  step: WslMoveProgressStep
  migrationId?: string
  phase?: WslMoveCutoverPhase
  /** While copying: bytes sent of the total. */
  bytesSent?: number
  bytesTotal?: number
  /**
   * The run ended without committing (refused, reset, waiting): how, so a window that only followed
   * its progress (it reloaded mid-move, or the move started elsewhere) can show the result too.
   */
  result?: WslMoveResult
}

/** A committed move whose host steps are not all confirmed yet, for the sidebar/settings notice. */
export type WslMoveUnfinished = {
  migrationId: string
  distro: string
  automationsPending: string[]
}

export const WSL_MOVE_PROGRESS_CHANNEL = 'wslMove:progress'
