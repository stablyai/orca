import { getPersistedEditorOwnerFields } from '@/lib/editor-file-operation-owner'
import type { AppState } from '../../../types'
import { type ClosedEditorTabSnapshot, MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { appendRecentlyClosedTabKind, pushRecentlyClosedTabKind } from '../../recently-closed-tabs'

export type ParkedRecoveredEditorDrafts = Pick<
  AppState,
  'recentlyClosedEditorTabsByWorktree' | 'recentlyClosedTabKindsByWorktree'
>

/** Ordinary close history may expire; recovered unsaved text must remain available. */
export function retainClosedEditorSnapshots(
  snapshots: readonly ClosedEditorTabSnapshot[]
): ClosedEditorTabSnapshot[] {
  let savedCount = 0
  return snapshots.filter(
    (snapshot) =>
      snapshot.dirtyDraftContent !== undefined || ++savedCount <= MAX_RECENT_CLOSED_EDITOR_TABS
  )
}

function recoveryKey(snapshot: ClosedEditorTabSnapshot): string {
  const owner = getPersistedEditorOwnerFields(snapshot)
  return JSON.stringify([
    snapshot.worktreeId,
    snapshot.filePath,
    owner.runtimeEnvironmentId ?? null,
    owner.externalSshTargetId ?? null,
    snapshot.dirtyDraftContent,
    snapshot.lastKnownDiskSignature ?? null
  ])
}

export function parkRecoveredEditorDrafts(
  state: ParkedRecoveredEditorDrafts,
  worktreeId: string,
  snapshots: readonly ClosedEditorTabSnapshot[]
): ParkedRecoveredEditorDrafts {
  const existing = state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
  const seen = new Set(
    existing.filter((entry) => entry.dirtyDraftContent !== undefined).map(recoveryKey)
  )
  const additions = snapshots.filter((snapshot) => {
    const key = recoveryKey(snapshot)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
  if (additions.length === 0) {
    return state
  }
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: retainClosedEditorSnapshots([...additions, ...existing])
    },
    recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor',
      additions.length
    )
  }
}

/** Queue a blocked draft behind other closes without discarding its only copy. */
export function deferRecoveredEditorDraft(
  state: ParkedRecoveredEditorDrafts,
  worktreeId: string,
  snapshot: ClosedEditorTabSnapshot
): ParkedRecoveredEditorDrafts {
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: retainClosedEditorSnapshots([
        ...(state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []),
        snapshot
      ])
    },
    recentlyClosedTabKindsByWorktree: appendRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor'
    )
  }
}
