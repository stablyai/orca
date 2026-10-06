import { useMemo, useSyncExternalStore } from 'react'

/**
 * Terminal creates sent to a paired host that have not settled yet, so the strip can show the tab
 * on click instead of after the host round-trip (or, over a dead return path, after reconnect).
 *
 * Module-level on purpose: the host mints the tab id, so there is no row to stage in the tab model,
 * and these must never reach the persisted session.
 */
export type PendingWebRuntimeTerminalCreate = {
  id: string
  worktreeId: string
  /** Null when the host picks the group; the worktree's active group shows it. */
  groupId: string | null
  label: string
}

const EMPTY: readonly PendingWebRuntimeTerminalCreate[] = []
let pending: readonly PendingWebRuntimeTerminalCreate[] = EMPTY
let nextId = 0
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): readonly PendingWebRuntimeTerminalCreate[] {
  return pending
}

function getServerSnapshot(): readonly PendingWebRuntimeTerminalCreate[] {
  return EMPTY
}

function publish(next: readonly PendingWebRuntimeTerminalCreate[]): void {
  pending = next
  for (const listener of listeners) {
    listener()
  }
}

/** Shows a pending tab until the returned callback runs; calling it again is a no-op. */
export function beginPendingWebRuntimeTerminalCreate(
  entry: Omit<PendingWebRuntimeTerminalCreate, 'id'>
): () => void {
  const id = `pending-web-terminal-create:${(nextId += 1)}`
  publish([...pending, { ...entry, id }])
  return () => {
    if (pending.some((candidate) => candidate.id === id)) {
      publish(pending.filter((candidate) => candidate.id !== id))
    }
  }
}

export function readPendingWebRuntimeTerminalCreates(): readonly PendingWebRuntimeTerminalCreate[] {
  return pending
}

export function usePendingWebRuntimeTerminalCreates(
  worktreeId: string,
  groupId: string,
  activeGroupId: string | null
): readonly PendingWebRuntimeTerminalCreate[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return useMemo(() => {
    const rows = all.filter(
      (entry) =>
        entry.worktreeId === worktreeId && (entry.groupId ?? activeGroupId ?? groupId) === groupId
    )
    return rows.length > 0 ? rows : EMPTY
  }, [activeGroupId, all, groupId, worktreeId])
}
