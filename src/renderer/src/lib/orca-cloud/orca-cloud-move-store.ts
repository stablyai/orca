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
      archiveAfter: boolean
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
    }
  | {
      stage: 'failed'
      workspaceId: string
      name: string
      step: CloudMoveStep
      /** The move gave up after MOVE_TIMEOUT_MS. */
      timedOut: boolean
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
  setCloudMoveState({ stage: 'confirm', workspaceId, name, known: null, archiveAfter: true })
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

/** "Hide": the move keeps going behind a toast; Show (or the result) brings the dialog back. */
export function hideRunningMove(hidden: boolean): void {
  if (state.stage === 'running') {
    setCloudMoveState({ ...state, hidden })
  }
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
    const parsed: unknown = raw.startsWith('{')
      ? JSON.parse(raw)
      : { at: Number(raw), localWorktreeId: null }
    const value = parsed as Partial<CloudWorkspaceMoved>
    return typeof value.at === 'number' && Number.isFinite(value.at)
      ? {
          at: value.at,
          localWorktreeId: typeof value.localWorktreeId === 'string' ? value.localWorktreeId : null
        }
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
