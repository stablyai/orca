// "Move to this computer" state: confirm (a dialog) → running (steps) → done / partial / failed (a
// progress card in the notification stack, minimizable to the status bar like the update card).
// Any entry point (context menu, status panel) opens it; CloudMoveToComputerDialogHost renders it.
import { useSyncExternalStore } from 'react'
import { isCloudWorkspaceArchived } from './orca-cloud-workspace-store'
import type {
  CloudTransferFinished,
  CloudTransferPrepared
} from '../../../../shared/hosted-sandbox/cloud-transfer-api'

export type CloudMoveStep = 'waking' | 'packing' | 'downloading' | 'creating' | 'applying'
export const CLOUD_MOVE_STEPS: readonly CloudMoveStep[] = [
  'waking',
  'packing',
  'downloading',
  'creating',
  'applying'
]

export type CloudMoveState =
  | { stage: 'closed' }
  | {
      stage: 'confirm'
      workspaceId: string
      name: string
      /** What the client cache already knows (asleep-view snapshot); null until read or when empty. */
      known: CloudMoveKnownCounts | null
      /** Null until the user touches the checkbox: then the default (on unless agents run there) applies. */
      archiveAfter: boolean | null
      /** Already archived: the move unarchives it to copy it, then archives it again (no checkbox). */
      archived?: boolean
    }
  | {
      stage: 'running'
      workspaceId: string
      name: string
      step: CloudMoveStep
      /** Steps that were skipped (the workspace was already awake). */
      skipped: CloudMoveStep[]
      startedAt: number
      bytes: number | null
      totalBytes: number | null
      archiveAfter: boolean
      /**
       * Cancel: offered while waking, packing and downloading ('available'), then 'cancelling'
       * until the move has stopped and cleaned up; null where it can no longer be honoured.
       */
      cancel: 'available' | 'cancelling' | null
      /** Minimized to the status bar; progress keeps going. */
      minimized: boolean
    }
  | {
      stage: 'done'
      workspaceId: string
      name: string
      localWorktreeId: string
      prepared: CloudTransferPrepared
      finished: CloudTransferFinished
      elapsedMs: number
      /** "Archive the cloud workspace afterwards" was ticked: it is being archived (with undo). */
      archivedAfter: boolean
      /** The user's archive-afterwards choice (a partial result archives after Apply again). */
      archiveAfter: boolean
      /** Minimized to the status bar. */
      minimized: boolean
    }
  | {
      stage: 'failed'
      workspaceId: string
      name: string
      step: CloudMoveStep
      /** The move gave up after MOVE_TIMEOUT_MS. */
      timedOut: boolean
      /** Main's reason code when it is one the card names (too_large, no_local_repo, busy…). */
      reason: string | null
      /** Retry would help: false for failures it repeats exactly, and while a timed-out run settles. */
      retryable: boolean
      /** What the move put back: a workspace it unarchived is archived again. */
      restored: 'archived' | null
      /** The local worktree that was created before the failure, if any. */
      localWorktreeId: string | null
      /** Set when the apply step failed on an existing worktree: "Apply changes again" retries it. */
      retry?: { prepared: CloudTransferPrepared; worktreePath: string } | null
      /** The user's archive-afterwards choice, so Try again keeps it. */
      archiveAfter: boolean
      /** Minimized to the status bar. */
      minimized: boolean
    }

type CloudMoveKnownCounts = {
  branch: string | null
  uncommittedChanges: number
  chats: number
}

let state: CloudMoveState = { stage: 'closed' }
const listeners = new Set<() => void>()

export function setCloudMoveState(next: CloudMoveState): void {
  state = next
  for (const listener of listeners) {
    listener()
  }
}

export function getCloudMoveState(): CloudMoveState {
  return state
}

export function useCloudMoveState(): CloudMoveState {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }, getCloudMoveState)
}

export function openMoveToThisComputer(workspaceId: string, name: string): void {
  // A move in flight keeps its card; opening another one would orphan its progress.
  if (state.stage === 'running') {
    if (state.minimized) {
      setCloudMoveState({ ...state, minimized: false })
    }
    return
  }
  if (
    (state.stage === 'done' || state.stage === 'failed') &&
    state.minimized &&
    state.workspaceId === workspaceId
  ) {
    setCloudMoveState({ ...state, minimized: false })
    return
  }
  setCloudMoveState({
    stage: 'confirm',
    workspaceId,
    name,
    known: null,
    archiveAfter: null,
    ...(isCloudWorkspaceArchived(workspaceId) ? { archived: true } : {})
  })
  // Counts from the client cache, so the confirm screen can say what moves without waking anything.
  void (typeof window === 'undefined' ? undefined : window.api?.orcaCloudOffline)
    ?.getSnapshot({ workspaceId })
    .then((snapshot) => {
      const current = getCloudMoveState()
      if (!snapshot || current.stage !== 'confirm' || current.workspaceId !== workspaceId) {
        return
      }
      setCloudMoveState({
        ...current,
        known: {
          branch: snapshot.git?.branch ?? null,
          uncommittedChanges: snapshot.git ? trackedChangeCount(snapshot.git) : 0,
          chats: snapshot.chats.length
        }
      })
    })
    .catch(() => undefined)
}

/**
 * Changed tracked files: the confirm line names untracked files separately ("…, plus untracked
 * files"), and a file both staged and unstaged is one change.
 */
function trackedChangeCount(git: {
  changes: readonly { path: string; area: string }[]
  changeCount: number
}): number {
  const untracked = git.changes.filter((change) => change.area === 'untracked').length
  // The snapshot lists a capped number of changes: past the cap, count what isn't untracked.
  if (git.changes.length < git.changeCount) {
    return Math.max(0, git.changeCount - untracked)
  }
  return new Set(
    git.changes.filter((change) => change.area !== 'untracked').map((change) => change.path)
  ).size
}

export function setMoveArchiveAfter(archiveAfter: boolean): void {
  if (state.stage === 'confirm') {
    setCloudMoveState({ ...state, archiveAfter })
  }
}

/** Minimize to the status bar (the move keeps going) or expand the card again. */
export function setMoveMinimized(minimized: boolean): void {
  if (
    (state.stage === 'running' || state.stage === 'done' || state.stage === 'failed') &&
    state.minimized !== minimized
  ) {
    setCloudMoveState({ ...state, minimized })
  }
}

/** The checkbox default: archive afterwards unless agents are running there (archiving stops them). */
export function effectiveArchiveAfter(
  archiveAfter: boolean | null,
  runningAgents: number
): boolean {
  return archiveAfter ?? runningAgents === 0
}

export function closeMoveToThisComputer(): void {
  if (state.stage !== 'running') {
    setCloudMoveState({ stage: 'closed' })
  }
}

const MOVED_KEY = 'orca-cloud-moved-at:'

type CloudWorkspaceMoved = { at: number; localWorktreeId: string | null }

/** When this cloud workspace was last copied to this computer, and where (the panel's quiet line). */
export function cloudWorkspaceMoved(workspaceId: string): CloudWorkspaceMoved | null {
  try {
    const raw = window.localStorage.getItem(`${MOVED_KEY}${workspaceId}`)
    if (!raw) {
      return null
    }
    // Older entries are a bare timestamp.
    if (!raw.startsWith('{')) {
      const at = Number(raw)
      return Number.isFinite(at) ? { at, localWorktreeId: null } : null
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || !('at' in parsed)) {
      return null
    }
    const at = parsed.at
    const local = 'localWorktreeId' in parsed ? parsed.localWorktreeId : null
    return typeof at === 'number' && Number.isFinite(at)
      ? { at, localWorktreeId: typeof local === 'string' ? local : null }
      : null
  } catch {
    return null
  }
}

export function noteCloudWorkspaceMoved(
  workspaceId: string,
  at: number,
  localWorktreeId: string | null = null
): void {
  try {
    window.localStorage.setItem(
      `${MOVED_KEY}${workspaceId}`,
      JSON.stringify({ at, localWorktreeId })
    )
  } catch {
    // Storage unavailable: the marker is a nicety.
  }
}
