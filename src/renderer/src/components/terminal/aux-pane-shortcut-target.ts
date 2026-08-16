import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createTerminalPaneHandleRegistry } from '@/components/floating-terminal/terminal-pane-handle-registry'
import { getAuxPaneGroupIdForTarget } from '@/lib/aux-pane-window-registry'

export type TerminalShortcutTarget = {
  worktreeId: string
  groupId: string | undefined
  auxiliary: boolean
}

export function auxiliaryTerminalShortcutTarget(
  target: TerminalShortcutTarget | null
): TerminalShortcutTarget | null {
  return target?.auxiliary ? target : null
}

export function resolveTerminalCreationShortcutWorktreeId(
  target: TerminalShortcutTarget | null,
  floatingWorkspaceFocused: boolean
): string | null {
  return floatingWorkspaceFocused ? FLOATING_TERMINAL_WORKTREE_ID : (target?.worktreeId ?? null)
}

type TerminalShortcutPaneHandle = { closeActivePane: () => void }
const terminalShortcutPaneHandles = createTerminalPaneHandleRegistry<TerminalShortcutPaneHandle>()

export const getTerminalShortcutPaneHandle = (tabId: string): TerminalShortcutPaneHandle | null =>
  terminalShortcutPaneHandles.getHandle(tabId)

export const getTerminalShortcutPaneRefCallback = (
  tabId: string
): ((handle: TerminalShortcutPaneHandle | null) => void) =>
  terminalShortcutPaneHandles.getRefCallback(tabId)

export function resolveTerminalShortcutTabId(
  target: Pick<TerminalShortcutTarget, 'worktreeId' | 'groupId'>,
  state: {
    groupsByWorktree: Record<string, TabGroup[]>
    unifiedTabsByWorktree: Record<string, Tab[]>
  }
): string | null {
  const group = target.groupId
    ? (state.groupsByWorktree[target.worktreeId] ?? []).find(
        (candidate) => candidate.id === target.groupId
      )
    : undefined
  if (!group?.activeTabId) {
    return null
  }
  const tab = (state.unifiedTabsByWorktree[target.worktreeId] ?? []).find(
    (candidate) => candidate.id === group.activeTabId
  )
  return tab?.contentType === 'terminal' ? tab.entityId : null
}

export function resolveTerminalShortcutTarget(
  target: EventTarget | null,
  state: {
    activeWorktreeId: string | null
    activeGroupIdByWorktree: Record<string, string>
    groupsByWorktree: Record<string, TabGroup[]>
  }
): TerminalShortcutTarget | null {
  const auxGroupId = getAuxPaneGroupIdForTarget(target)
  if (auxGroupId) {
    for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
      if (groups.some((group) => group.id === auxGroupId)) {
        return { worktreeId, groupId: auxGroupId, auxiliary: true }
      }
    }
    return null
  }
  const worktreeId = state.activeWorktreeId
  return worktreeId
    ? {
        worktreeId,
        groupId: state.activeGroupIdByWorktree[worktreeId],
        auxiliary: false
      }
    : null
}
