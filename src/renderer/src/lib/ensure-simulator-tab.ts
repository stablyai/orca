import { useAppStore } from '@/store'
import { findReusableRightSplitGroupId } from './emulator-right-split-target'
import { cancelPendingSimulatorPaneShutdown } from './simulator-pane-shutdown-scheduler'
import { shouldShutdownSimulatorForPaneUnmountFromTabs } from './simulator-tab-shutdown'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  findAmbiguousWorktreeIds,
  getActiveExecutionHostIdForWorktree,
  isUnifiedTabOwnedByWorktree
} from './unified-tab-host-ownership'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'

type EnsureSimulatorTabOptions = {
  targetGroupId?: string
  placement?: 'activeGroup' | 'rightSplit'
  /** When true, activate the tab and focus the owning group (default true). */
  surfacePane?: boolean
  executionHostId?: ExecutionHostId
}

type ExistingSimulatorTab = {
  id: string
  groupId: string
  contentType: string
}

function getSimulatorWorktrees(state: ReturnType<typeof useAppStore.getState>, worktreeId: string) {
  return [
    ...(state.allWorktrees?.() ?? []),
    ...(state.folderWorkspaces ?? []).map(folderWorkspaceToWorktree)
  ].filter((worktree) => worktree.id === worktreeId)
}

function resolveSimulatorExecutionHostId(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string,
  requestedHostId?: ExecutionHostId
): ExecutionHostId | undefined {
  const worktrees = getSimulatorWorktrees(state, worktreeId)
  const preferredHostId = requestedHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
  if (
    preferredHostId &&
    worktrees.some((worktree) => isExecutionHostAliasForWorktree(preferredHostId, worktree))
  ) {
    return preferredHostId
  }
  if (requestedHostId) {
    return requestedHostId
  }
  return worktrees.length === 1 ? (worktrees[0].hostId ?? LOCAL_EXECUTION_HOST_ID) : requestedHostId
}

export function getSimulatorTabForWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): ExistingSimulatorTab | null {
  const state = useAppStore.getState()
  const worktrees = getSimulatorWorktrees(state, worktreeId)
  const activeExecutionHostId =
    executionHostId ?? getActiveExecutionHostIdForWorktree(state, worktreeId)
  const activeWorktree = worktrees.find((worktree) =>
    activeExecutionHostId ? isExecutionHostAliasForWorktree(activeExecutionHostId, worktree) : false
  )
  const simulatorTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'simulator'
  )
  if (worktrees.length === 0) {
    if (executionHostId) {
      return simulatorTabs.find((tab) => tab.executionHostId === executionHostId) ?? null
    }
    return simulatorTabs[0] ?? null
  }
  if (executionHostId && !activeWorktree) {
    return simulatorTabs.find((tab) => tab.executionHostId === executionHostId) ?? null
  }
  const target = activeWorktree ?? (worktrees.length === 1 ? worktrees[0] : null)
  if (!target) {
    return null
  }
  const ambiguousWorktreeIds = findAmbiguousWorktreeIds(worktrees)
  return (
    simulatorTabs.find((tab) => isUnifiedTabOwnedByWorktree(tab, target, ambiguousWorktreeIds)) ??
    null
  )
}

/** One simulator tab per worktree; focuses existing tab instead of creating duplicates. */
export function ensureSimulatorTab(
  worktreeId: string,
  options?: EnsureSimulatorTabOptions
): string | null {
  const store = useAppStore.getState()
  if (store.settings?.mobileEmulatorEnabled === false) {
    return null
  }
  const sourceGroupId =
    options?.targetGroupId ??
    store.activeGroupIdByWorktree[worktreeId] ??
    store.groupsByWorktree[worktreeId]?.[0]?.id
  if (!sourceGroupId) {
    return null
  }
  cancelPendingSimulatorPaneShutdown(worktreeId)

  const executionHostId = resolveSimulatorExecutionHostId(
    store,
    worktreeId,
    options?.executionHostId
  )
  const existing = getSimulatorTabForWorktree(worktreeId, executionHostId)
  const shouldSurface = options?.surfacePane ?? true
  if (existing) {
    if (shouldSurface && store.activeWorktreeId === worktreeId) {
      store.activateTab(existing.id)
      store.focusGroup(worktreeId, existing.groupId)
      store.setActiveTabType('simulator')
    }
    return existing.id
  }

  if (options?.placement === 'rightSplit' && shouldSurface) {
    const reusableRightGroupId = findReusableRightSplitGroupId(
      store.layoutByWorktree[worktreeId],
      sourceGroupId
    )
    if (reusableRightGroupId) {
      const tab = store.createUnifiedTab(worktreeId, 'simulator', {
        label: translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator'),
        targetGroupId: reusableRightGroupId,
        activate: true,
        ...(executionHostId ? { executionHostId } : {})
      })
      store.activateTab(tab.id)
      store.setActiveTabType('simulator')
      store.focusGroup(worktreeId, tab.groupId)
      return tab.id
    }

    // Why: publish the simulator directly in its split group. A two-step
    // create-then-move can persist the midpoint during dev reload/HMR.
    const splitTab = store.createUnifiedTabInSplit(
      worktreeId,
      'simulator',
      {
        sourceGroupId,
        splitDirection: 'right'
      },
      {
        label: translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator'),
        activate: true,
        ...(executionHostId ? { executionHostId } : {})
      }
    )
    if (splitTab) {
      return splitTab.id
    }
  }

  const tab = store.createUnifiedTab(worktreeId, 'simulator', {
    label: translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator'),
    targetGroupId: sourceGroupId,
    activate: shouldSurface,
    ...(executionHostId ? { executionHostId } : {})
  })
  if (shouldSurface) {
    store.activateTab(tab.id)
    store.setActiveTabType('simulator')
    store.focusGroup(worktreeId, tab.groupId)
  }
  return tab.id
}

export { shouldShutdownSimulatorForPaneUnmountFromTabs }
