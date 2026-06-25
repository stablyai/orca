import { useAppStore } from '@/store'
import { findReusableRightSplitGroupId } from './emulator-right-split-target'
import { cancelPendingSimulatorPaneShutdown } from './simulator-pane-shutdown-scheduler'
import { shouldShutdownSimulatorForPaneUnmountFromTabs } from './simulator-tab-shutdown'
import { translate } from '@/i18n/i18n'

export const isMacOsHost = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

type EnsureSimulatorTabOptions = {
  targetGroupId?: string
  placement?: 'activeGroup' | 'rightSplit'
  /** When true, activate the tab and focus the owning group (default true). */
  surfacePane?: boolean
}

type ExistingSimulatorTab = {
  id: string
  groupId: string
  contentType: string
}

export function getSimulatorTabForWorktree(worktreeId: string): ExistingSimulatorTab | null {
  return (
    (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'simulator'
    ) ?? null
  )
}

/** One simulator tab per worktree; focuses existing tab instead of creating duplicates. */
export function ensureSimulatorTab(
  worktreeId: string,
  options?: EnsureSimulatorTabOptions
): string | null {
  if (!isMacOsHost) {
    return null
  }
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

  const existing = getSimulatorTabForWorktree(worktreeId)
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
        activate: true
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
        activate: true
      }
    )
    if (splitTab) {
      return splitTab.id
    }
  }

  const tab = store.createUnifiedTab(worktreeId, 'simulator', {
    label: translate('auto.lib.ensure.simulator.tab.372d21d428', 'Mobile Emulator'),
    targetGroupId: sourceGroupId,
    activate: shouldSurface
  })
  if (shouldSurface) {
    store.activateTab(tab.id)
    store.setActiveTabType('simulator')
    store.focusGroup(worktreeId, tab.groupId)
  }
  return tab.id
}

export function countSimulatorTabs(
  worktreeId: string,
  options: { excludingTabId?: string } = {}
): number {
  return (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'simulator' && tab.id !== options.excludingTabId
  ).length
}

export function shouldShutdownSimulatorForPaneUnmount(worktreeId: string, tabId?: string): boolean {
  return shouldShutdownSimulatorForPaneUnmountFromTabs(
    useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [],
    tabId
  )
}

export { shouldShutdownSimulatorForPaneUnmountFromTabs }
