// "Move to this computer" dialog state: confirm → running (steps) → done / partial / failed. Any
// entry point (context menu, status panel) opens it; CloudMoveToComputerDialogHost renders it.
import { useSyncExternalStore } from 'react'
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
      /** Hidden behind a toast; progress keeps going and the dialog returns when it settles. */
      hidden: boolean
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
      /** Settled while hidden: stays a notice until Show (never steals focus). */
      hidden: boolean
    }
  | {
      stage: 'failed'
      workspaceId: string
      name: string
      step: CloudMoveStep
      /** The move gave up after MOVE_TIMEOUT_MS. */
      timedOut: boolean
      /** The local worktree that was created before the failure, if any. */
      localWorktreeId: string | null
      /** The user's archive-afterwards choice, so Try again keeps it. */
      archiveAfter: boolean
      /** Settled while hidden: stays a notice until Show (never steals focus). */
      hidden: boolean
    }

export type CloudMoveKnownCounts = {
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
  // A move in flight keeps its dialog; opening another one would orphan its progress.
  if (state.stage === 'running') {
    if (state.hidden) {
      setCloudMoveState({ ...state, hidden: false })
    }
    return
  }
  if (
    (state.stage === 'done' || state.stage === 'failed') &&
    state.hidden &&
    state.workspaceId === workspaceId
  ) {
    setCloudMoveState({ ...state, hidden: false })
    return
  }
  setCloudMoveState({ stage: 'confirm', workspaceId, name, known: null, archiveAfter: null })
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
          uncommittedChanges: snapshot.git?.changeCount ?? 0,
          chats: snapshot.chats.length
        }
      })
    })
    .catch(() => undefined)
}

export function setMoveArchiveAfter(archiveAfter: boolean): void {
  if (state.stage === 'confirm') {
    setCloudMoveState({ ...state, archiveAfter })
  }
}

/** "Hide": the move keeps going behind a notice; only Show brings the dialog back. */
export function hideRunningMove(hidden: boolean): void {
  if (state.stage === 'running' || state.stage === 'done' || state.stage === 'failed') {
    setCloudMoveState({ ...state, hidden })
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

export type CloudWorkspaceMoved = { at: number; localWorktreeId: string | null }

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
