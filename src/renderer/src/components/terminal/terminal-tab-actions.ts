import { useAppStore } from '@/store'
import { closeWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import { getLatestWebSessionTabsPublicationEpoch } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { resolveHostSessionTabIdForWebSessionTab } from '@/runtime/web-session-tabs-sync/tracking-mappings'
import { resolveTerminalCloseRoute } from '@/lib/terminal-close-route'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel,
  shouldConfirmPinnedTabClose
} from '@/store/pinned-tab-close-guard'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import {
  guardRunningTerminalClose,
  shouldConfirmRunningTerminalClose
} from './running-terminal-close-guard'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { runAsAutomaticDeselection } from '@/store/active-worktree-deselection-intent'
import { getTerminalIncarnationHandle } from './terminal-close-incarnation'
import {
  getWorktreeTerminalTabIds,
  resolveTerminalCloseTarget,
  validatePrecomputedTerminalCloseState,
  type PrecomputedTerminalCloseState
} from './terminal-close-target'
export type { PrecomputedTerminalCloseState } from './terminal-close-target'
export { closeOtherTerminalTabs, closeTerminalTabsToRight } from './terminal-tab-bulk-actions'

export function closeTerminalTab(
  tabId: string,
  options?: {
    force?: boolean
    rejectPinned?: boolean
    reason?: TerminalTabCloseReason
    /** Host-only lifecycle reason; local pin guards still use reason, so this must not bypass them. */
    hostCloseReason?: TerminalTabCloseReason
    /** PTY whose lifecycle event initiated the host close. */
    lifecyclePtyId?: string
    /** Skip modals for unattended/bulk/CLI/RPC paths and confirmed re-entry. */
    skipRunningProcessConfirm?: boolean
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
    const closeReason = options?.reason ?? options?.hostCloseReason ?? 'user'
    if (closeReason !== 'pty-exit') {
      // Why: late explicit cleanup must still revoke tab-scoped resume authority after PTY exit removed the row.
      state.closeTab(tabId, {
        reason: closeReason,
        ...(options?.localPtyTeardownOwnedExternally
          ? { localPtyTeardownOwnedExternally: true }
          : {}),
        ...(options?.precomputedRetirementPlan
          ? { precomputedRetirementPlan: options.precomputedRetirementPlan }
          : {})
      })
    }
    options?.onClosed?.()
    return
  }
  const { worktreeId: owningWorktreeId, terminalTabId } = target
  // Unrouted closes still prune and record locally; unproven-host PTY teardown fails closed independently.
  const worktreeRoute = resolveTerminalCloseRoute(state, owningWorktreeId, terminalTabId)

  // Why: with the pin prompt turned off, the close itself is the user's consent.
  let pinnedCloseConsented = false
  // Pinned confirmation re-enters with force; ordinary closes must wait for consent.
  if (
    options?.reason !== 'pty-exit' &&
    !options?.force &&
    isUnifiedTabPinned(state, owningWorktreeId, terminalTabId)
  ) {
    // Unattended lifecycle callers cannot wait on a modal; reject pinned closes without bypassing consent.
    if (options?.rejectPinned) {
      options.onCancel?.()
      return
    }
    // Disabling pin prompts must not bypass running-process confirmation for busy pinned tabs (#10142).
    if (shouldConfirmPinnedTabClose(state)) {
      guardPinnedTabClose({
        isPinned: true,
        tabLabel: resolvePinnedTabLabel(state, owningWorktreeId, terminalTabId),
        onClose: () => closeTerminalTab(tabId, { ...options, force: true }),
        ...(options?.onCancel ? { onCancel: options.onCancel } : {})
      })
      return
    }
    pinnedCloseConsented = true
  }

  // Guard before web routing so X, middle-click, menu, keyboard and host-backed closes share running-process policy (#10142).
  if (shouldConfirmRunningTerminalClose(options)) {
    guardRunningTerminalClose({
      terminalTabId,
      tabLabel: resolvePinnedTabLabel(state, owningWorktreeId, terminalTabId),
      // Re-enter after consent to revalidate pinned, route, and precomputed state against the latest store.
      onClose: () => closeTerminalTab(tabId, { ...options, skipRunningProcessConfirm: true }),
      ...(options?.onCancel ? { onCancel: options.onCancel } : {})
    })
    return
  }

  const runtimeEnvironmentId = worktreeRoute?.runtimeEnvironmentId ?? null
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    if (options?.reason === 'pty-exit') {
      // Why: stream exit is not host-tab closure; the HUB snapshot decides whether reconnect restores or removes this tab.
      return
    }
    // Send closes to the authoritative host even for unmapped/plain-UUID IDs, or its next snapshot resurrects the tab; unknown local IDs safely no-op there.
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
    // Prune local mirrors while awaiting the host snapshot so close feels immediate.
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
      // Bind lifecycle evidence to the exact observed host publication and terminal incarnation.
      reason: wireReason,
      ...(wireReason !== 'user'
        ? {
            publicationEpoch,
            terminalHandle: lifecycleTerminalHandle
          }
        : // Why: a confirmed pinned close (this window's prompt, a phone's, or the prompt turned off).
          options?.force || pinnedCloseConsented
          ? { force: true }
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
  // closeUnifiedTab owns MRU/neighbor repair across all tab types; terminal-only preselection would overwrite it.
  const hasUnifiedRow = (state.unifiedTabsByWorktree?.[owningWorktreeId] ?? []).some(
    (tab) =>
      tab.contentType === 'terminal' && (tab.entityId === terminalTabId || tab.id === terminalTabId)
  )
  if (
    !hasUnifiedRow &&
    terminalCountBeforeClose > 1 &&
    state.activeWorktreeId === owningWorktreeId &&
    terminalTabId === state.activeTabId
  ) {
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
  if (terminalCountBeforeClose <= 1 && state.activeWorktreeId === owningWorktreeId) {
    // Re-read after closeUnifiedTab repairs/deactivates the surface; stale state must not clobber it.
    const current = useAppStore.getState()
    if (current.activeWorktreeId === owningWorktreeId) {
      // Only unified renderable count includes agent-session/simulator tabs when proving the worktree empty.
      const { renderableTabCount } = current.reconcileWorktreeTabModel(owningWorktreeId)
      if (renderableTabCount === 0) {
        const worktreeFile = current.openFiles.find((f) => f.worktreeId === owningWorktreeId)
        if (worktreeFile) {
          current.setActiveFile(worktreeFile.id)
          current.setActiveTabType('editor', owningWorktreeId)
        } else {
          const browserTab = (current.browserTabsByWorktree?.[owningWorktreeId] ?? [])[0]
          if (browserTab) {
            current.setActiveBrowserTab(browserTab.id)
            current.setActiveTabType('browser', owningWorktreeId)
          } else if (options?.reason === 'pty-exit') {
            runAsAutomaticDeselection(() => current.setActiveWorktree(null))
          } else {
            current.setActiveWorktree(null)
          }
        }
      }
    }
  }
  options?.onClosed?.()
}
