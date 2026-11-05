import { useAppStore, type AppState } from '@/store'
import { resolveTerminalCloseRoute } from '@/lib/terminal-close-route'
import type { TerminalTabRetirementState } from '@/store/slices/terminal-tab-retirement'

export type KillAllTerminalSurfaceState = TerminalTabRetirementState &
  Pick<AppState, 'activeWorktreeId'>

// Why: a runtime host's tab is that host's to close; closing it here stops a paired machine's work (#38135).
// A tab whose owner is not proven stays open: Kill All must never guess another machine's sessions are ours.
function isOwnedByThisDesktop(
  state: KillAllTerminalSurfaceState,
  worktreeId: string,
  terminalId: string
): boolean {
  return resolveTerminalCloseRoute(state, worktreeId, terminalId)?.runtimeEnvironmentId === null
}

export function snapshotKillAllTerminalSurfaceIds(
  state: KillAllTerminalSurfaceState = useAppStore.getState()
): string[] {
  const targetIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (isOwnedByThisDesktop(state, worktreeId, tab.id)) {
        targetIds.add(tab.id)
      }
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal' && isOwnedByThisDesktop(state, worktreeId, tab.entityId)) {
        targetIds.add(tab.entityId)
      }
    }
  }
  return [...targetIds]
}

export function getKillAllTargetIndex(
  state: KillAllTerminalSurfaceState,
  targetIds: ReadonlySet<string>
): {
  ownerByTargetId: Map<string, string>
  terminalIdsByWorktree: Map<string, Set<string>>
} {
  const ownerByTargetId = new Map<string, string>()
  const terminalIdsByWorktree = new Map<string, Set<string>>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (
        targetIds.has(tab.id) &&
        !ownerByTargetId.has(tab.id) &&
        isOwnedByThisDesktop(state, worktreeId, tab.id)
      ) {
        ownerByTargetId.set(tab.id, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        ids.add(tab.entityId)
      }
      if (
        tab.contentType === 'terminal' &&
        targetIds.has(tab.entityId) &&
        !ownerByTargetId.has(tab.entityId) &&
        isOwnedByThisDesktop(state, worktreeId, tab.entityId)
      ) {
        ownerByTargetId.set(tab.entityId, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  return { ownerByTargetId, terminalIdsByWorktree }
}
