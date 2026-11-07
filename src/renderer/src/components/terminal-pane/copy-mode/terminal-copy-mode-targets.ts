import type { AppState } from '@/store/types'

export type TerminalCopyModeTarget = {
  available: () => boolean
  enter: () => boolean
}

const targets = new Map<string, TerminalCopyModeTarget>()

export function registerTerminalCopyModeTarget(
  tabId: string,
  target: TerminalCopyModeTarget
): () => void {
  targets.set(tabId, target)
  return () => {
    if (targets.get(tabId) === target) {
      targets.delete(tabId)
    }
  }
}

export function resolveTerminalCopyModeTarget(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string | null,
  groupId: string | null
): TerminalCopyModeTarget | null {
  if (!worktreeId || !groupId) {
    return null
  }
  const group = state.groupsByWorktree?.[worktreeId]?.find((entry) => entry.id === groupId)
  const tab = state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (entry) => entry.id === group?.activeTabId && entry.groupId === groupId
  )
  if (tab?.contentType !== 'terminal') {
    return null
  }
  const target = targets.get(tab.entityId)
  return target?.available() ? target : null
}
