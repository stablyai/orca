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
import { translate } from '@/i18n/i18n'
import {
  guardPinnedTabClose,
  isUnifiedTabPinned,
  resolvePinnedTabLabel,
  shouldConfirmPinnedTabClose
} from '@/store/pinned-tab-close-guard'
import {
  closeStructuredTerminalSessionWithRetry,
  disposeStructuredTerminalSession,
  structuredTerminalSessionId
} from './structured-terminal-session-disposal'
import { toast } from 'sonner'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '@/store/slices/terminal-tab-retirement'
import {
  guardRunningTerminalClose,
  shouldConfirmRunningTerminalClose
} from './running-terminal-close-guard'
import { closeLocalTerminalTabState } from './close-local-terminal-tab-state'
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
    /** Close reason sent to the host only. Unlike `reason`, it does not skip
     *  local guards (pinned confirmation keys off `reason === 'pty-exit'`),
     *  so lifecycle echoes that still need those guards can tag the wire. */
    hostCloseReason?: TerminalTabCloseReason
    /** PTY whose lifecycle event initiated the host close. */
    lifecyclePtyId?: string
    /** Set by callers that must never raise a modal (bulk closes, CLI/RPC, lifecycle
     *  fallbacks) and by the re-entry that runs once the user confirmed. */
    skipRunningProcessConfirm?: boolean
    captureRecentlyClosed?: boolean
    localPtyTeardownOwnedExternally?: boolean
    /** Internal re-entry after the structured provider close is proven. */
    structuredSessionCloseConfirmed?: boolean
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
    isUnifiedTabPinned(state, owningWorktreeId, terminalTabId)
  ) {
    // Why: background lifecycle callers cannot safely wait on a modal whose
    // owner may be unattended; reject pinned tabs without bypassing the guard.
    if (options?.rejectPinned) {
      options.onCancel?.()
      return
    }
    // Why: the pin prompt supersedes the running-process one only when it actually
    // appears. With `confirmClosePinnedTab` off it says nothing, so fall through and let
    // a busy pinned tab still get asked — Cmd+W did exactly that before #10142.
    if (shouldConfirmPinnedTabClose(state)) {
      guardPinnedTabClose({
        isPinned: true,
        tabLabel: resolvePinnedTabLabel(state, owningWorktreeId, terminalTabId),
        onClose: () => closeTerminalTab(tabId, { ...options, force: true }),
        ...(options?.onCancel ? { onCancel: options.onCancel } : {})
      })
      return
    }
  }

  // Why: the X button, middle-click and the tab menu used to skip the running-process
  // prompt that Cmd+W enforced (#10142). Guarding here — above the web-runtime branch so
  // host-backed tabs are covered too — gives every close path one shared policy.
  if (shouldConfirmRunningTerminalClose(options)) {
    guardRunningTerminalClose({
      terminalTabId,
      tabLabel: resolvePinnedTabLabel(state, owningWorktreeId, terminalTabId),
      // Why: re-enter instead of continuing inline so pinned/route/precomputed state is
      // re-validated against fresh state after an arbitrarily long dialog.
      onClose: () => closeTerminalTab(tabId, { ...options, skipRunningProcessConfirm: true }),
      ...(options?.onCancel ? { onCancel: options.onCancel } : {})
    })
    return
  }

  const runtimeEnvironmentId = worktreeRoute.runtimeEnvironmentId
  const structuredSessionId = structuredTerminalSessionId(
    state.unifiedTabsByWorktree?.[owningWorktreeId],
    terminalTabId
  )
  if (
    structuredSessionId &&
    options?.reason !== 'pty-exit' &&
    options?.structuredSessionCloseConfirmed !== true
  ) {
    const target = runtimeEnvironmentId
      ? ({ kind: 'environment', environmentId: runtimeEnvironmentId } as const)
      : ({ kind: 'local' } as const)
    void closeStructuredTerminalSessionWithRetry(target, structuredSessionId).then((closed) => {
      if (!closed) {
        toast.error(
          translate(
            'components.native-chat.structuredSessionCloseFailed',
            'Could not close this Codex chat'
          ),
          {
            description: translate(
              'components.native-chat.structuredSessionCloseFailedDescription',
              'The terminal stayed open so the provider remains recoverable.'
            )
          }
        )
        options?.onCancel?.()
        return
      }
      closeTerminalTab(tabId, {
        ...options,
        force: true,
        skipRunningProcessConfirm: true,
        structuredSessionCloseConfirmed: true
      })
    })
    return
  }
  const retireStructuredSession = (): void => {
    const closeReason = options?.reason ?? options?.hostCloseReason ?? 'user'
    const target = runtimeEnvironmentId
      ? ({ kind: 'environment', environmentId: runtimeEnvironmentId } as const)
      : ({ kind: 'local' } as const)
    if (options?.structuredSessionCloseConfirmed === true) {
      return
    }
    disposeStructuredTerminalSession({
      unifiedTabs: state.unifiedTabsByWorktree?.[owningWorktreeId],
      terminalTabId,
      target,
      reason: closeReason
    })
  }
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
    retireStructuredSession()
    options?.onClosed?.()
    return
  }

  const currentTerminalTabIds = precomputedCloseState
    ? null
    : getWorktreeTerminalTabIds(state, owningWorktreeId)
  const terminalCountBeforeClose =
    precomputedCloseState?.terminalCountBeforeClose ?? currentTerminalTabIds!.length
  // Why: a terminal with a unified row must leave successor choice to closeUnifiedTab's
  // MRU/neighbor repair — a terminal-only pre-pick skips agent-session/simulator neighbors
  // and re-stamps the group active before the canonical repair can run.
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
    // Why: re-read after the close — closeUnifiedTab may have already deactivated or
    // repaired the surface, and the pre-close snapshot must not clobber that outcome.
    const current = useAppStore.getState()
    if (current.activeWorktreeId === owningWorktreeId) {
      // Why: agent-session and simulator tabs render without a terminal/editor/browser
      // entity, so only the unified renderable count can prove the worktree is empty
      // (mirrors leaveWorktreeIfEmpty in useTabGroupTabCloseCommands).
      const { renderableTabCount } = current.reconcileWorktreeTabModel(owningWorktreeId)
      if (renderableTabCount === 0) {
        const worktreeFile = current.openFiles.find((f) => f.worktreeId === owningWorktreeId)
        if (worktreeFile) {
          current.setActiveFile(worktreeFile.id)
          current.setActiveTabType('editor')
        } else {
          const browserTab = (current.browserTabsByWorktree?.[owningWorktreeId] ?? [])[0]
          if (browserTab) {
            current.setActiveBrowserTab(browserTab.id)
            current.setActiveTabType('browser')
          } else {
            current.setActiveWorktree(null)
          }
        }
      }
    }
  }
  retireStructuredSession()
  options?.onClosed?.()
}
