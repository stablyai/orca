import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TabSplitTarget } from '../slices/tabs/tabs-slice-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  resolveWorktreeOperationRouteResult,
  resolveWorktreeOperationRouteResultForHost
} from '@/lib/workspace/ownership/worktree-operation-route'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { workspaceEditorFiles } from '../slices/editor/tabs/workspace-editor-files'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createActiveWorkspaceTerminalActions(
  _set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<TerminalSlice, 'openNewTerminalTabInActiveWorkspace'> {
  return {
    openNewTerminalTabInActiveWorkspace: async (
      groupId,
      targetWorktreeId,
      executionHostId,
      shellOverride
    ) => {
      const worktreeId = targetWorktreeId ?? get().activeWorktreeId
      if (worktreeId) {
        await openNewTerminalTabInWorkspace(
          get,
          worktreeId,
          groupId,
          undefined,
          executionHostId,
          shellOverride
        )
      }
    }
  }
}

export async function openNewTerminalTabInWorkspace(
  get: TerminalStoreGet,
  worktreeId: string,
  groupId?: string,
  split?: TabSplitTarget,
  executionHostId?: ExecutionHostId,
  shellOverride?: string
): Promise<void> {
  const state = get()
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const worktreeRoute =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID || workspaceScope?.type === 'folder'
      ? null
      : executionHostId
        ? resolveWorktreeOperationRouteResultForHost(state, worktreeId, executionHostId)
        : resolveWorktreeOperationRouteResult(state, worktreeId)
  if (worktreeRoute && worktreeRoute.kind !== 'resolved') {
    return
  }
  const selectedOwner =
    !worktreeRoute && executionHostId
      ? runtimeEnvironmentIdForWorkspaceOwner(state, {
          workspaceId: worktreeId,
          hostId: executionHostId
        })
      : undefined
  if (selectedOwner?.kind === 'ambiguous') {
    return
  }
  const runtimeEnvironmentId = worktreeRoute
    ? worktreeRoute.route.runtimeEnvironmentId
    : executionHostId
      ? selectedOwner?.kind === 'resolved'
        ? selectedOwner.environmentId
        : null
      : worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? null
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
          selectWorktree: !split,
          ...(shellOverride === undefined ? {} : { shell: shellOverride })
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
  const terminal = get().createTab(
    worktreeId,
    groupId,
    shellOverride,
    split || executionHostId
      ? {
          ...(split ? { split } : {}),
          ...(executionHostId ? { executionHostId } : {})
        }
      : undefined
  )
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
