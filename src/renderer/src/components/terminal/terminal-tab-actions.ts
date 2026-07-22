import { useAppStore } from '@/store'
import type { TabContentType } from '../../../../shared/types'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import { reconcileTabOrder } from '../tab-bar/reconcile-order'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive,
  toHostSessionTabId
} from '@/runtime/web-runtime-session'
import {
  getLatestWebSessionTabsPublicationEpoch,
  resolveHostSessionTabIdForWebSessionTab
} from '@/runtime/web-session-tabs-sync'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { getTerminalIncarnationHandle } from './terminal-close-incarnation'
import {
  getWorktreeTerminalTabIds,
  resolveTerminalCloseTarget,
  validatePrecomputedTerminalCloseState,
  type PrecomputedTerminalCloseState
} from './terminal-close-target'
export type { PrecomputedTerminalCloseState } from './terminal-close-target'

const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type TerminalTabActionState = ReturnType<typeof useAppStore.getState>

function isPinnedVisibleTab(
  state: TerminalTabActionState,
  worktreeId: string,
  visibleId: string
): boolean {
  return (
    (state.unifiedTabsByWorktree?.[worktreeId] ?? []).some(
      (tab) => (tab.id === visibleId || tab.entityId === visibleId) && tab.isPinned
    ) ?? false
  )
}

export function closeTerminalTab(
  tabId: string,
  options?: {
    force?: boolean
    rejectPinned?: boolean
    reason?: TerminalTabCloseReason
    /** Close reason sent to the host only. Unlike `reason`, it does not skip
     *  local guards (pinned confirmation keys off `reason === 'pty-exit'`),
     *  so lifecycle echoes that still need those guards can tag the wire. */
    hostCloseReason?: TerminalTabCloseReason
    /** PTY whose lifecycle event initiated the host close. */
    lifecyclePtyId?: string
    captureRecentlyClosed?: boolean
    localPtyTeardownOwnedExternally?: boolean
    precomputedRetirementPlan?: TerminalTabRetirementPlan
    precomputedCloseState?: PrecomputedTerminalCloseState
    onClosed?: () => void
    onCancel?: () => void
  }
): void {
  const state = useAppStore.getState()
  const precomputedCloseState = validatePrecomputedTerminalCloseState(
    tabId,
    options?.precomputedRetirementPlan,
    options?.precomputedCloseState
  )
  const target = resolveTerminalCloseTarget(state, tabId, precomputedCloseState)
  if (!target) {
    options?.onClosed?.()
    return
  }
  const { worktreeId: owningWorktreeId, terminalTabId } = target

  // Why: a pinned tab routes through the confirmation guard instead of closing
  // outright. `force` is the post-confirmation re-entry, which skips the guard.
  if (
    options?.reason !== 'pty-exit' &&
    !options?.force &&
    isPinnedVisibleTab(state, owningWorktreeId, terminalTabId)
  ) {
    // Why: background lifecycle callers cannot safely wait on a modal whose
    // owner may be unattended; reject pinned tabs without bypassing the guard.
    if (options?.rejectPinned) {
      options.onCancel?.()
      return
    }
    guardPinnedTabClose({
      isPinned: true,
      tabLabel: resolvePinnedTabLabel(state, owningWorktreeId, terminalTabId),
      onClose: () => closeTerminalTab(tabId, { ...options, force: true }),
      ...(options?.onCancel ? { onCancel: options.onCancel } : {})
    })
    return
  }

  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, owningWorktreeId)
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: a remote-owned worktree's tabs are host-authoritative, so the close
    // MUST reach the host or its next snapshot re-adds the tab (the "close then
    // snaps back" bug). When the local→host map has no entry, decode the id
    // itself (toHostSessionTabId is a no-op for non-mirrored host ids like plain
    // UUIDs) — mirroring what activate/move do. The old
    // `isWebTerminalSurfaceTabId ? id : null` gate returned null for plain-UUID
    // host tabs, so close silently fell back to a local-only prune and the host's
    // next snapshot re-added the tab. A truly local id the host doesn't know is
    // harmless: the host close no-ops and the local prune still stands.
    const hostBackedTabId =
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId: runtimeEnvironmentId,
        worktreeId: owningWorktreeId,
        tabId: terminalTabId
      }) ?? toHostSessionTabId(terminalTabId)
    const wireReason = options?.reason ?? options?.hostCloseReason ?? 'user'
    const lifecycleTerminalHandle =
      wireReason === 'user'
        ? null
        : getTerminalIncarnationHandle(options?.lifecyclePtyId ?? '', runtimeEnvironmentId)
    const publicationEpoch =
      wireReason === 'user'
        ? null
        : getLatestWebSessionTabsPublicationEpoch(runtimeEnvironmentId, owningWorktreeId)
    // Why: prune local mirrors immediately so close feels responsive while the
    // host session snapshot catches up.
    closeLocalTerminalTabState(terminalTabId, {
      reason: options?.reason,
      ...(options?.captureRecentlyClosed !== undefined
        ? { captureRecentlyClosed: options.captureRecentlyClosed }
        : {}),
      remoteCloseOwnedByHost: true,
      ...(options?.localPtyTeardownOwnedExternally
        ? { localPtyTeardownOwnedExternally: true }
        : {}),
      ...(options?.precomputedRetirementPlan
        ? { precomputedRetirementPlan: options.precomputedRetirementPlan }
        : {})
    })
    void closeWebRuntimeSessionTab({
      worktreeId: owningWorktreeId,
      tabId: hostBackedTabId,
      environmentId: runtimeEnvironmentId,
      // Why: lifecycle evidence binds this stale-prone echo to the exact host
      // publication and terminal incarnation that the renderer observed.
      reason: wireReason,
      ...(wireReason !== 'user'
        ? {
            publicationEpoch,
            terminalHandle: lifecycleTerminalHandle
          }
        : {})
    })
    options?.onClosed?.()
    return
  }

  const currentTerminalTabIds = precomputedCloseState
    ? null
    : getWorktreeTerminalTabIds(state, owningWorktreeId)
  const terminalCountBeforeClose =
    precomputedCloseState?.terminalCountBeforeClose ?? currentTerminalTabIds!.length
  if (terminalCountBeforeClose <= 1) {
    closeLocalTerminalTabState(terminalTabId, {
      reason: options?.reason,
      ...(options?.captureRecentlyClosed !== undefined
        ? { captureRecentlyClosed: options.captureRecentlyClosed }
        : {}),
      ...(options?.localPtyTeardownOwnedExternally
        ? { localPtyTeardownOwnedExternally: true }
        : {}),
      ...(options?.precomputedRetirementPlan
        ? { precomputedRetirementPlan: options.precomputedRetirementPlan }
        : {})
    })
    if (state.activeWorktreeId === owningWorktreeId) {
      // Why: only deactivate the worktree when no tabs of any kind remain.
      // Editor files are a separate tab type; closing the last terminal tab
      // should switch to the editor view instead of tearing down the workspace.
      const worktreeFile = state.openFiles.find((f) => f.worktreeId === owningWorktreeId)
      if (worktreeFile) {
        state.setActiveFile(worktreeFile.id)
        state.setActiveTabType('editor')
      } else {
        const browserTab = (state.browserTabsByWorktree?.[owningWorktreeId] ?? [])[0]
        if (browserTab) {
          state.setActiveBrowserTab(browserTab.id)
          state.setActiveTabType('browser')
        } else {
          state.setActiveWorktree(null)
        }
      }
    }
    options?.onClosed?.()
    return
  }

  if (state.activeWorktreeId === owningWorktreeId && terminalTabId === state.activeTabId) {
    const currentIndex = currentTerminalTabIds?.indexOf(terminalTabId) ?? -1
    const nextTabId = precomputedCloseState
      ? precomputedCloseState.nextTerminalTabId
      : (currentTerminalTabIds![currentIndex + 1] ?? currentTerminalTabIds![currentIndex - 1])
    if (nextTabId) {
      state.setActiveTab(nextTabId)
    }
  }

  closeLocalTerminalTabState(terminalTabId, {
    reason: options?.reason,
    ...(options?.captureRecentlyClosed !== undefined
      ? { captureRecentlyClosed: options.captureRecentlyClosed }
      : {}),
    ...(options?.localPtyTeardownOwnedExternally ? { localPtyTeardownOwnedExternally: true } : {}),
    ...(options?.precomputedRetirementPlan
      ? { precomputedRetirementPlan: options.precomputedRetirementPlan }
      : {})
  })
  options?.onClosed?.()
}

export function closeOtherTerminalTabs(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }
  const state = useAppStore.getState()
  const currentTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  state.setActiveTab(tabId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  for (const tab of currentTabs) {
    if (tab.id !== tabId) {
      if (isPinnedVisibleTab(state, activeWorktreeId, tab.id)) {
        continue
      }
      if (closeHostTerminalTabs) {
        // Why: paired web tabs are host-owned; local-only bulk close leaves
        // the host to re-publish the supposedly closed terminal tabs.
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
}

export function closeTerminalTabsToRight(tabId: string, activeWorktreeId: string | null): void {
  if (!activeWorktreeId) {
    return
  }

  const state = useAppStore.getState()
  const currentTerminalTabs = state.tabsByWorktree[activeWorktreeId] ?? []
  const currentEditorFiles = state.openFiles.filter((f) => f.worktreeId === activeWorktreeId)
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId)
  const closeHostTerminalTabs = isWebRuntimeSessionActive(runtimeEnvironmentId)
  const terminalIds = currentTerminalTabs.map((t) => t.id)
  const terminalIdSet = new Set(terminalIds)
  const orderedIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[activeWorktreeId],
    terminalIds,
    currentEditorFiles.map((f) => f.id)
  )

  const index = orderedIds.indexOf(tabId)
  if (index === -1) {
    return
  }
  const rightIds = orderedIds.slice(index + 1)
  for (const id of rightIds) {
    if (isPinnedVisibleTab(state, activeWorktreeId, id)) {
      continue
    }
    if (terminalIdSet.has(id)) {
      if (closeHostTerminalTabs) {
        // Why: paired web tabs are host-owned; local-only bulk close leaves
        // the host to re-publish the supposedly closed terminal tabs.
        void closeWebRuntimeSessionTab({
          worktreeId: activeWorktreeId,
          tabId: id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      } else {
        state.closeTab(id)
      }
    } else {
      const unifiedTab = (state.unifiedTabsByWorktree?.[activeWorktreeId] ?? []).find(
        (tab) => tab.entityId === id && EDITOR_TAB_CONTENT_TYPES.has(tab.contentType)
      )
      if (!unifiedTab?.isPinned) {
        useAppStore.getState().closeFile(id)
      }
    }
  }
}

export function activateTerminalTab(tabId: string): void {
  const s = useAppStore.getState()
  const owningWorktreeId =
    Object.entries(s.tabsByWorktree).find(([, worktreeTabs]) =>
      worktreeTabs.some((tab) => tab.id === tabId)
    )?.[0] ?? null
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(s, owningWorktreeId)
  if (owningWorktreeId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: activation needs to update the host's active tab as well as the
    // local optimistic state, otherwise the next host snapshot snaps back.
    void activateWebRuntimeSessionTab({
      worktreeId: owningWorktreeId,
      tabId,
      environmentId: runtimeEnvironmentId
    })
  }
  s.setActiveTab(tabId)
  s.setActiveTabType('terminal')
}

export function toggleTerminalPaneExpand(tabId: string): void {
  useAppStore.getState().setActiveTab(tabId)
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, {
        detail: { tabId }
      })
    )
  })
}
