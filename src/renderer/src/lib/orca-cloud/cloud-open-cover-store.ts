// JA-12: a just-created Orca Cloud workspace showed a blank pane for ~1 s between the start screen
// and its terminal (the create finishes, then the terminal's PTY attaches over the network). The
// start screen's last frame stays up over the new workspace until its PTY is attached, or a cap.
import { useSyncExternalStore } from 'react'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'

/** Never cover longer than this: a terminal that is slow to attach shows its own state. */
export const CLOUD_OPEN_COVER_MAX_MS = 6_000

export type CloudOpenCover = {
  worktreeId: string
  /** The start screen as it was when the create finished ("Open workspace" running). */
  entry: PendingWorktreeCreation
  heldAt: number
}

let covers: Readonly<Record<string, CloudOpenCover>> = {}
const listeners = new Set<() => void>()

function emit(next: Readonly<Record<string, CloudOpenCover>>): void {
  covers = next
  for (const listener of listeners) {
    listener()
  }
}

export function holdCloudOpenCover(
  worktreeId: string,
  entry: PendingWorktreeCreation,
  now = Date.now()
): void {
  emit({ ...covers, [worktreeId]: { worktreeId, entry, heldAt: now } })
}

export function releaseCloudOpenCover(worktreeId: string): void {
  if (!covers[worktreeId]) {
    return
  }
  const { [worktreeId]: _released, ...rest } = covers
  emit(rest)
}

export function getCloudOpenCover(worktreeId: string | null): CloudOpenCover | null {
  return worktreeId ? (covers[worktreeId] ?? null) : null
}

export function useCloudOpenCover(worktreeId: string | null): CloudOpenCover | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => getCloudOpenCover(worktreeId)
  )
}

/** True once any terminal of the workspace has a PTY attached. */
export function workspaceHasAttachedPty(
  state: {
    tabsByWorktree: Readonly<Record<string, readonly { id: string }[] | undefined>>
    ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  },
  worktreeId: string
): boolean {
  return (state.tabsByWorktree[worktreeId] ?? []).some(
    (tab) => (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0
  )
}

/** Test seam. */
export function resetCloudOpenCovers(): void {
  emit({})
}
