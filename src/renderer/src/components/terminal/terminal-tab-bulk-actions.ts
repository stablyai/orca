import { editorTabsNeedingSavePrompt } from '@/store/slices/editor/tabs/editor-tab-close-target'
import { afterPendingTabs } from '@/runtime/layout-owner-pending-tabs'
import { requestEditorFileClose } from '../editor/autosave/editor-autosave'
import { runAfterEditorFramesFlush } from '../editor/save/flush/editor-pending-flush'
import {
  hasUnroutableTerminalWorktreeOwner,
  resolveTerminalWorktreeRoute
} from '@/lib/terminal-worktree-route'
import { closeWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { useAppStore } from '@/store'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

type TerminalTabBulkActionState = ReturnType<typeof useAppStore.getState>

function isPinnedVisibleTab(
  state: TerminalTabBulkActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id === tabId || isPinnedVisibleTab(state, activeWorktreeId, tab.id)) {
      continue
    }
    if (closeHostTerminalTabs) {
      // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
      closeLocalTerminalTabState(tab.id, { remoteCloseOwnedByHost: true })
      void closeWebRuntimeSessionTab({
        worktreeId: activeWorktreeId,
        tabId: tab.id,
        environmentId: runtimeEnvironmentId,
        reason: 'user'
      })
    } else {
      state.closeTab(tab.id)
    }
  }
}

export function closeTerminalTabsToRight(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  if (hasUnroutableTerminalWorktreeOwner(state, activeWorktreeId)) {
    return
  }
  const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const editorTabs = (state.unifiedTabsByWorktree[activeWorktreeId] ?? []).filter((tab) =>
    isEditorTabContentType(tab.contentType)
  )
  const editorById = new Map(editorTabs.map((tab) => [tab.id, tab]))
  const runtimeEnvironmentId = resolveTerminalWorktreeRoute(
    state,
    activeWorktreeId
  )?.runtimeEnvironmentId
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  const terminalIds = currentTerminalTabs.map((tab) => tab.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[activeWorktreeId],
    terminalIds,
    editorTabs.map((tab) => tab.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  const closingEditors: typeof editorTabs = []
  for (const id of orderedIds.slice(index + 1)) {
    if (isPinnedVisibleTab(state, activeWorktreeId, id)) {
      continue
    }
    if (terminalIdSet.has(id)) {
      if (closeHostTerminalTabs) {
        // Why: prune the mirror immediately, then close on its authoritative host so snapshots converge.
        closeLocalTerminalTabState(id, { remoteCloseOwnedByHost: true })
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      } else {
        state.closeTab(id)
      }
      continue
    }
    const tab = editorById.get(id)
    if (tab && !tab.isPinned) {
      closingEditors.push(tab)
    }
  }
  runAfterEditorFramesFlush(
    useAppStore.getState(),
    closingEditors.map((tab) => tab.entityId),
    () => {
      const latest = useAppStore.getState()
      const liveIds = new Set(
        (latest.unifiedTabsByWorktree[activeWorktreeId] ?? [])
          .filter((tab) => !tab.isPinned)
          .map((tab) => tab.id)
      )
      const live = closingEditors.filter((tab) => liveIds.has(tab.id))
      const promptIds = editorTabsNeedingSavePrompt(latest, live)
      const closingIds = live.filter((tab) => !promptIds.has(tab.id)).map((tab) => tab.id)
      latest.closeUnifiedTabs(closingIds)
      afterPendingTabs(closingIds, () => {
        for (const tab of live) {
          if (promptIds.has(tab.id)) {
            requestEditorFileClose(tab.entityId, { tabId: tab.id })
          }
        }
      })
    }
  )
}
