// Spotlight testing: sync a workspace worktree's tracked changes onto the repo
// root checkout so it can be tested against the root's installed toolchain
// (node_modules, native builds, running dev servers) without duplicating it.

export type SpotlightStatus = 'active' | 'syncing'

export type SpotlightErrorCode =
  /** Rebase/merge/cherry-pick in progress in the root or holder worktree. */
  | 'operation-in-progress'
  /** Root HEAD moved off the snapshot or picked up changes while active. */
  | 'root-diverged'
  /** Untracked root files would be overwritten by newly tracked snapshot paths. */
  | 'untracked-collision'
  /** The repo has not opted into Spotlight testing (settings toggle off). */
  | 'not-enabled'
  /** Restoring the root's uncommitted changes conflicted on deactivate. */
  | 'restore-conflict'
  /** The root's original branch was deleted while Spotlight was active. */
  | 'branch-missing'
  | 'unborn-head'
  | 'bare-root'
  /** The main worktree cannot hold the Spotlight (it IS the sync target). */
  | 'root-is-holder'
  /** The repo root isn't on its primary branch, so there's no clean branch to
   *  return it to — the user must check the primary branch out first. */
  | 'not-on-primary-branch'
  | 'repo-not-found'
  | 'worktree-not-found'
  | 'not-active'
  | 'unsupported-host'
  | 'git-failed'

export type SpotlightError = {
  code: SpotlightErrorCode
  message: string
}

export type SpotlightRepoState = {
  repoId: string
  /** Worktree currently holding the Spotlight (its changes mirror to the root). */
  holderWorktreeId: string
  status: SpotlightStatus
  /** Root branch to re-attach on deactivate; null = root was detached. */
  originalBranch: string | null
  originalHeadSha: string
  /** Stash-form commit of the root's uncommitted state; == originalHeadSha when clean. */
  backupSha: string
  lastSnapshotSha: string | null
  activatedAt: number
  lastSyncAt: number | null
  lastError: SpotlightError | null
}

export type SpotlightStateSnapshot = {
  byRepo: Record<string, SpotlightRepoState>
}

export type SpotlightOpResult =
  | {
      ok: true
      state: SpotlightRepoState | null
      /** Set by deactivate when the root couldn't return to its original branch
       *  (deleted, or checked out in another worktree) and was left detached.
       *  The value is that branch's name, or null if it no longer exists. */
      leftDetachedFromBranch?: string | null
    }
  | { ok: false; error: SpotlightError; state: SpotlightRepoState | null }

/** Pushed by main on every state transition (activate/sync/deactivate/takeover/reconcile). */
export type SpotlightChangedEvent = {
  repoId: string
  state: SpotlightRepoState | null
}

/** What the spotlight refs in the repo actually say — source of truth for reconcile. */
export type SpotlightRefsSnapshot = {
  snapshotSha: string | null
  backupSha: string | null
  originalHeadSha: string | null
  originalBranch: string | null
  /** Current root HEAD, for detecting divergence from the snapshot. */
  rootHeadSha: string | null
}

/** Where the Spotlight terminal's output is mirrored, relative to the repo
 *  root. Agents discover it via the ORCA_SPOTLIGHT_LOG env var. */
export const SPOTLIGHT_LOG_RELATIVE_PATH = '.orca/spotlight.log'

/** Machine-readable Spotlight status next to the log — lets an agent check
 *  whether ITS workspace currently holds the Spotlight before treating log
 *  errors as its own. */
export const SPOTLIGHT_STATE_RELATIVE_PATH = '.orca/spotlight-state.json'

export const SPOTLIGHT_REFS = {
  snapshot: 'refs/orca/spotlight/snapshot',
  backup: 'refs/orca/spotlight/backup',
  originalHead: 'refs/orca/spotlight/original-head',
  originalBranch: 'refs/orca/spotlight/original-branch'
} as const
