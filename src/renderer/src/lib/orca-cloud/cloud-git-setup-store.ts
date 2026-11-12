// GIT-SETUP: the window's per-workspace strip state beside the cloud workspace store. Whether git
// setup failed comes from the status read; this keeps what the person did about it: dismissed the
// strip for this app session (a wake brings it back), or restarted without it being fixed.
import { useSyncExternalStore } from 'react'
import type { CloudWakeSource } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudGitSetupState = {
  /** The strip's ×, in memory only: an app restart or a wake shows it again. */
  dismissed: Readonly<Record<string, true>>
  /** A restart finished and git setup still failed ("Restarting didn't fix it"). */
  restarted: Readonly<Record<string, true>>
}

const EMPTY: CloudGitSetupState = { dismissed: {}, restarted: {} }
let state: CloudGitSetupState = EMPTY
const listeners = new Set<() => void>()

function update(patch: (current: CloudGitSetupState) => Partial<CloudGitSetupState>): void {
  state = { ...state, ...patch(state) }
  for (const listener of listeners) {
    listener()
  }
}

function without(record: Readonly<Record<string, true>>, key: string): Record<string, true> {
  const next = { ...record }
  delete next[key]
  return next
}

export function getCloudGitSetupState(): CloudGitSetupState {
  return state
}

export function useCloudGitSetup<T>(select: (current: CloudGitSetupState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => select(state),
    () => select(EMPTY)
  )
}

export function dismissCloudGitSetup(workspaceId: string): void {
  update((s) => ({ dismissed: { ...s.dismissed, [workspaceId]: true } }))
}

/** A status read: once git works again, a later failure starts from the first message. */
export function noteCloudGitSetupRead(workspaceId: string, failed: boolean): void {
  if (!failed && state.restarted[workspaceId]) {
    update((s) => ({ restarted: without(s.restarted, workspaceId) }))
  }
}

/**
 * A wake or restart reached ready: a dismissed strip may show again. Returns what to run once the
 * fresh status is in, so the old read never flashes "didn't fix it": a restart that left git setup
 * failed counts as the retry that didn't fix it.
 */
export function noteCloudGitSetupReady(
  workspaceId: string,
  source: CloudWakeSource,
  failed: () => boolean
): () => void {
  const failedBefore = failed()
  if (state.dismissed[workspaceId]) {
    update((s) => ({ dismissed: without(s.dismissed, workspaceId) }))
  }
  return () => {
    if (source === 'restart' && failedBefore && failed()) {
      update((s) => ({ restarted: { ...s.restarted, [workspaceId]: true } }))
    }
  }
}

/** Test/fixture seam. */
export function seedCloudGitSetupState(next: Partial<CloudGitSetupState>): void {
  update(() => ({ ...EMPTY, ...next }))
}
