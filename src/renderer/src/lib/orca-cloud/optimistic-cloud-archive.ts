// ARCHIVE-NOW: Archive shows the archived page the moment it is pressed, while the undo window, the
// repo's archive hook, the Sleep and the control-plane archive run behind it. The page reads this
// store; a failure reverts it and leaves an inline notice on the workspace instead of a toast.
import { useSyncExternalStore } from 'react'
import type { HostedArchiveHookFailure } from '../../../../shared/hosted-sandbox/hosted-archive-hook-wire'

export type OptimisticArchive = { startedAt: number } &
  /** The undo window: nothing has happened yet. `skipHook` only when it would wake for the hook. */
  (
    | {
        phase: 'undo'
        undo: () => void
        skipHook?: () => void
        /** The copy synced to this computer, which goes with the archive. */
        localCopy?: { hasLocalCopy: boolean; editedHere: number }
      }
    | { phase: 'archiving'; step: 'hook' | 'hook-waking' | 'saving' }
    /** The hook failed: the page shows its output and asks. */
    | {
        phase: 'hook-failed'
        failure: HostedArchiveHookFailure
        decide: (archive: boolean) => void
      }
  )

const archives = new Map<string, OptimisticArchive>()
const failures = new Map<string, string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setOptimisticArchive(workspaceId: string, next: OptimisticArchive | null): void {
  if (next) {
    archives.set(workspaceId, next)
    failures.delete(workspaceId)
  } else {
    archives.delete(workspaceId)
  }
  emit()
}

export function getOptimisticArchive(workspaceId: string): OptimisticArchive | undefined {
  return archives.get(workspaceId)
}

/** The archive failed after the page showed: the workspace is back, with this reason inline. */
export function setCloudArchiveFailure(workspaceId: string, message: string | null): void {
  if (message === null) {
    failures.delete(workspaceId)
  } else {
    archives.delete(workspaceId)
    failures.set(workspaceId, message)
  }
  emit()
}

export function getCloudArchiveFailure(workspaceId: string): string | undefined {
  return failures.get(workspaceId)
}

// The snapshot is the entry itself (a new object on every write): the React Compiler memoizes a
// read the hook doesn't take from useSyncExternalStore, so a version-only snapshot never re-rendered.
export function useOptimisticArchive(workspaceId: string): OptimisticArchive | undefined {
  return useSyncExternalStore(subscribe, () => archives.get(workspaceId))
}

export function useCloudArchiveFailure(workspaceId: string): string | undefined {
  return useSyncExternalStore(subscribe, () => failures.get(workspaceId))
}

export function resetOptimisticCloudArchivesForTests(): void {
  archives.clear()
  failures.clear()
  emit()
}
