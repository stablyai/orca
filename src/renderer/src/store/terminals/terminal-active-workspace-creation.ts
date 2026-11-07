import type { TabSplitTarget } from '../slices/tabs'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { isWebClientLocation } from '@/lib/web-client-location'
import { workspaceEditorFiles } from '../slices/editor/tabs/workspace-editor-files'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createActiveWorkspaceTerminalActions(
  _set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'openNewTerminalTabInActiveWorkspace'> {
  return {
    openNewTerminalTabInActiveWorkspace: async (groupId) => {
      const worktreeId = get().activeWorktreeId
      if (worktreeId) {
        await openNewTerminalTabInWorkspace(get, worktreeId, groupId)
      }
    }
  }
}

export async function openNewTerminalTabInWorkspace(
  get: TerminalStoreGet,
  worktreeId: string,
  groupId?: string,
  split?: TabSplitTarget
): Promise<void> {
  const state = get()
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const worktreeRoute =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || workspaceScope?.type === 'folder'
      ? null
      : resolveWorktreeOperationRouteResult(state, worktreeId)
  if (worktreeRoute && worktreeRoute.kind !== 'resolved') {
    return
  }
  const runtimeEnvironmentId =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? null
      : worktreeRoute
        ? worktreeRoute.route.runtimeEnvironmentId
        : runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  if (runtimeEnvironmentId) {
    const splitGroupId = split
      ? state.createEmptySplitGroup(worktreeId, split.sourceGroupId, split.splitDirection)
      : null
    if (split && !splitGroupId) {
      return
    }
    const closeEmptySplit = (): void => {
      if (splitGroupId) {
        get().closeEmptyGroup(worktreeId, splitGroupId)
      }
    }
    try {
      const { createWebRuntimeSessionTerminal } =
        await import('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation')
      await createWebRuntimeSessionTerminal(
        {
          worktreeId,
          environmentId: runtimeEnvironmentId,
          targetGroupId: splitGroupId ?? groupId,
          activate: true,
          selectWorktree: !split
        },
        { userAct: true }
      )
    } finally {
      // Host acceptance can settle before its tab is mirrored; keep only a populated split.
      closeEmptySplit()
    }
    return
  }
  if (isWebClientLocation() && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    return
  }
  const terminal = get().createTab(worktreeId, groupId, undefined, split ? { split } : undefined)
  get().setActiveTab(terminal.id)
  get().setActiveTabType('terminal', worktreeId)
  const latest = get()
  const currentTerminals = latest.tabsByWorktree[worktreeId] ?? []
  const currentEditors = workspaceEditorFiles(
    latest.openFiles,
    latest.unifiedTabsByWorktree[worktreeId]
  )
  const currentBrowsers = latest.browserTabsByWorktree[worktreeId] ?? []
  const stored = latest.tabBarOrderByWorktree[worktreeId]
  const validIds = new Set([
    ...currentTerminals.map((tab) => tab.id),
    ...currentEditors.map((tab) => tab.id),
    ...currentBrowsers.map((tab) => tab.id)
  ])
  const base = (stored ?? []).filter((id) => validIds.has(id))
  const inBase = new Set(base)
  for (const id of validIds) {
    if (!inBase.has(id)) {
      base.push(id)
    }
  }
  // Why: Cmd+J shares the titlebar-button creation path, so append the new terminal after mixed editor/browser tabs, not first.
  get().setTabBarOrder(worktreeId, [...base.filter((id) => id !== terminal.id), terminal.id])
  focusTerminalTabSurface(terminal.id)
}
