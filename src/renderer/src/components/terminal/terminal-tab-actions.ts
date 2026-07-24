import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  closeWebRuntimeSessionTab,
  isWebRuntimeSessionActive,
  toHostSessionTabId
} from '@/runtime/web-runtime-session'
import {
  getLatestWebSessionTabsPublicationEpoch,
  resolveHostSessionTabIdForWebSessionTab
} from '@/runtime/web-session-tabs-sync'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { guardPinnedTabClose, resolvePinnedTabLabel } from '@/store/pinned-tab-close-guard'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
import { getTerminalIncarnationHandle } from './terminal-close-incarnation'
import { awaitTerminalTabClose } from './terminal-tab-close-completion'
import { isPinnedVisibleTerminalTab } from './terminal-tab-pin-visibility'
import {
  reportTerminalCloseError,
  retireArchivedTerminalPtys
} from './terminal-tab-retirement-transaction'
import {
  archiveTerminalTabBeforeRetirement,
  canArchiveTerminalTabClose,
  isTerminalArchiveTopologyCurrent,
  terminalArchiveCloseUnavailableError
} from './terminal-archive-close'
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
    /** Close reason sent to the host only. Unlike `reason`, it does not skip
     *  local guards (pinned confirmation keys off `reason === 'pty-exit'`),
     *  so lifecycle echoes that still need those guards can tag the wire. */
    hostCloseReason?: TerminalTabCloseReason
    /** PTY whose lifecycle event initiated the host close. */
    lifecyclePtyId?: string
    captureRecentlyClosed?: boolean
    localPtyTeardownOwnedExternally?: boolean
    runtimePtyTeardownOwnedExternally?: boolean
    precomputedRetirementPlan?: TerminalTabRetirementPlan
    precomputedCloseState?: PrecomputedTerminalCloseState
    /** Internal re-entry after the archive durability boundary succeeds. */
    archiveCommitted?: boolean
    archiveId?: string
    onClosed?: (archiveId?: string) => void
    onCancel?: () => void
    onError?: (error: Error) => void
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
    options?.onClosed?.(options?.archiveId)
    return
  }
  const { worktreeId: owningWorktreeId, terminalTabId } = target
  const worktreeRoute = resolveTerminalWorktreeRoute(state, owningWorktreeId)
  if (!worktreeRoute) {
    options?.onCancel?.()
    return
  }
  // Why: a pinned tab routes through the confirmation guard instead of closing
  // outright. `force` is the post-confirmation re-entry, which skips the guard.
  if (
    options?.reason !== 'pty-exit' &&
    !options?.force &&
    isPinnedVisibleTerminalTab(owningWorktreeId, terminalTabId)
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
  const runtimeEnvironmentId = worktreeRoute.runtimeEnvironmentId
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    if (options?.reason === 'pty-exit') {
      // Why: stream exit is not host-tab closure; the HUB snapshot decides whether reconnect restores or removes this tab.
      return
    }
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
    // Archive-capable clients wait for the host durability receipt; older preloads stay optimistic.
    const closeLocalMirror = (archiveId = options?.archiveId): void => {
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
      options?.onClosed?.(archiveId)
    }
    if (options?.reason === 'pane-only') {
      closeLocalMirror()
      return
    }
    const hostClose = closeWebRuntimeSessionTab({
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
    if (wireReason === 'user') {
      void Promise.resolve(hostClose)
        .then((receipt) => {
          if (!receipt.closed || receipt.refused || !receipt.archiveId) {
            throw new Error(
              translate(
                'auto.components.terminal.terminal.tab.actions.a4f4c513c5',
                'Terminal archive protection did not receive a durable host receipt.'
              )
            )
          }
          closeLocalMirror(receipt.archiveId)
        })
        .catch((error: unknown) => {
          const archiveError =
            error instanceof Error ? error : new Error('terminal_tab_close_failed')
          reportTerminalCloseError(archiveError, options?.onError, () =>
            closeTerminalTab(tabId, options)
          )
        })
      return
    }
    void Promise.resolve(hostClose)
      .then((receipt) => {
        if (!receipt.closed || receipt.refused) {
          throw new Error(
            translate(
              'auto.components.terminal.terminal.tab.actions.fddc720203',
              'The execution host refused to close this tab.'
            )
          )
        }
        closeLocalMirror()
      })
      .catch((error: unknown) => {
        const closeError = error instanceof Error ? error : new Error('terminal_tab_close_failed')
        reportTerminalCloseError(closeError, options?.onError, () =>
          closeTerminalTab(tabId, options)
        )
      })
    return
  }
  const archiveReason = options?.reason ?? options?.hostCloseReason ?? 'user'
  if (!options?.archiveCommitted && archiveReason === 'user') {
    if (!canArchiveTerminalTabClose()) {
      reportTerminalCloseError(terminalArchiveCloseUnavailableError(), options?.onError, () =>
        closeTerminalTab(tabId, options)
      )
      return
    }
    void archiveTerminalTabBeforeRetirement(terminalTabId, owningWorktreeId)
      .then(async (receipt) => {
        if (!isTerminalArchiveTopologyCurrent(terminalTabId, receipt.topologyFingerprint)) {
          throw new Error(
            translate(
              'auto.components.terminal.terminal.tab.actions.43cd15a02d',
              'Terminal layout changed while archiving. Retry close to archive the latest panes.'
            )
          )
        }
        const retirementPlan = await retireArchivedTerminalPtys(terminalTabId, owningWorktreeId)
        closeTerminalTab(tabId, {
          ...options,
          archiveCommitted: true,
          archiveId: receipt.archiveId,
          captureRecentlyClosed: false,
          precomputedCloseState: undefined,
          // The state transition follows successful provider teardown; it must not issue a second kill.
          localPtyTeardownOwnedExternally: true,
          runtimePtyTeardownOwnedExternally: true,
          precomputedRetirementPlan: retirementPlan
        })
      })
      .catch((error: unknown) => {
        const archiveError = error instanceof Error ? error : new Error('terminal_archive_failed')
        reportTerminalCloseError(archiveError, options?.onError, () =>
          closeTerminalTab(tabId, options)
        )
      })
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
      ...(options?.runtimePtyTeardownOwnedExternally
        ? { runtimePtyTeardownOwnedExternally: true }
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
    options?.onClosed?.(options?.archiveId)
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
    ...(options?.runtimePtyTeardownOwnedExternally
      ? { runtimePtyTeardownOwnedExternally: true }
      : {}),
    ...(options?.precomputedRetirementPlan
      ? { precomputedRetirementPlan: options.precomputedRetirementPlan }
      : {})
  })
  options?.onClosed?.(options?.archiveId)
}

export function closeTerminalTabAsync(
  tabId: string,
  options?: Parameters<typeof closeTerminalTab>[1]
): Promise<void> {
  return awaitTerminalTabClose(closeTerminalTab, tabId, options)
}

export { activateTerminalTab, toggleTerminalPaneExpand } from './terminal-tab-activation'
