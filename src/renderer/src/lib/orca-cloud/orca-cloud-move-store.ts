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
  | { stage: 'confirm'; workspaceId: string; name: string }
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
    }
  | {
      stage: 'done'
      workspaceId: string
      name: string
      localWorktreeId: string
      prepared: CloudTransferPrepared
      finished: CloudTransferFinished
      elapsedMs: number
    }
  | { stage: 'failed'; workspaceId: string; name: string; step: CloudMoveStep }

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
    return
  }
  setCloudMoveState({ stage: 'confirm', workspaceId, name })
}

export function closeMoveToThisComputer(): void {
  if (state.stage !== 'running') {
    setCloudMoveState({ stage: 'closed' })
  }
}

const MOVED_KEY = 'orca-cloud-moved-at:'

/** When this cloud workspace was last moved to this computer (the panel's quiet "Moved" line). */
export function cloudWorkspaceMovedAt(workspaceId: string): number | null {
  try {
    const raw = window.localStorage.getItem(`${MOVED_KEY}${workspaceId}`)
    const at = raw ? Number(raw) : Number.NaN
    return Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

export function noteCloudWorkspaceMoved(workspaceId: string, at: number): void {
  try {
    window.localStorage.setItem(`${MOVED_KEY}${workspaceId}`, String(at))
  } catch {
    // Storage unavailable: the marker is a nicety.
  }
}
