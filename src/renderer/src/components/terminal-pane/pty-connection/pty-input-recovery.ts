import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { ambiguousWorkspaceOwnerMessage } from '@/lib/duplicate-paired-servers'
import { createIpcPtyTransport } from '../pty-transport'
import { createRemoteRuntimePtyTransport } from '../remote-runtime-pty-transport'
import { toAgentLaunchPreferences } from '../../../../../shared/agent-launch-preferences'
import { createUnresolvedOwnerPtyTransport } from '../unresolved-owner-pty-transport'
import { recordTerminalTabParkedOnUnresolvedHost } from '@/lib/parked-terminal-host-hydration'
import { getFitOverrideForPty, onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isPaneReplaying } from '../replay-guard'
import { registerUndeliverableWriteHandler } from '@/lib/pane-manager/terminal-write-pipeline-health'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { getSystemPrefersDark } from '@/lib/terminal-theme'
import { resolveTerminalColorSchemeMode } from '../../../../../shared/terminal-color-scheme-protocol'
import { discardTerminalOutput } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { terminalRendersInlineImages } from '@/lib/pane-manager/pane-inline-images'
import { CONPTY_DA1_RESPONSE } from '../../../../../shared/conpty-device-attributes'
import {
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers
} from '../terminal-capability-replies'

import { TRANSPORT_CONNECT_SETTLE_GRACE_MS } from './pty-connect-limits'
import { buildPaneTransportOptions } from './pane-transport-options'
import { createUnservedSshRowTransport } from './unserved-ssh-pane-connect'
import { createLegacyRelayBridgeTransport } from '../legacy-relay-bridge-transport'
import { legacyRelayBridgePtyIdForPane } from '../legacy-relay-bridge-panes'

import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { PtyTransport } from '../pty-transport-types'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { resolveTerminalInlineImagesEnabled } from '../../../../../shared/terminal-inline-images-settings'
import { PROGRAM_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/program-status/protocol'
import { readCachedRuntimeEnvironmentCapability } from '../../../runtime/runtime-rpc-client'

export function installPtyInputRecovery(session: ConnectPanePtySession): void {
  session.markAcceptedTerminalInputSent = (): void => {
    session.markTerminalInputSent()
    session.recordTerminalInputForHibernationFallback()
  }
  session.terminalTheme = session.pane.terminal.options.theme
  session.terminalColorQueryReplies = session.terminalTheme
    ? { foreground: session.terminalTheme.foreground, background: session.terminalTheme.background }
    : undefined
  const launchAgent = session.paneStartup?.launchAgent
  session.agentLaunchPreferences = launchAgent
    ? toAgentLaunchPreferences(session.paneStartup?.sessionOptions, launchAgent)
    : undefined
  session.transportOptions = buildPaneTransportOptions(session)
  if (session.connectionOwnerHydrating) {
    // Register unresolved-host panes for repo-change remount so hydration cannot leave an inert blank terminal.
    recordTerminalTabParkedOnUnresolvedHost(session.deps.worktreeId, session.deps.tabId)
  }
  session.transport =
    session.terminalOwnerUnresolved || session.connectionOwnerHydrating
      ? createUnresolvedOwnerPtyTransport(
          session.terminalOwnerUnresolved
            ? ambiguousWorkspaceOwnerMessage(useAppStore.getState(), session.deps.worktreeId)
            : 'Workspace host is still loading. Retry when the project finishes hydrating.'
        )
      : session.unservedSshTargetId
        ? createUnservedSshRowTransport(session, session.unservedSshTargetId)
        : session.runtimeEnvironmentId
          ? withLegacyRelayBridge(
              session,
              createRemoteRuntimePtyTransport(
                session.runtimeEnvironmentId,
                session.transportOptions
              )
            )
          : createIpcPtyTransport(session.transportOptions)
  session.canSendDesktopQueryReply = (): boolean => {
    const ptyId = session.transport.getPtyId()
    return !ptyId || !isPtyLocked(ptyId)
  }
  // Capability handlers bypass onData; mobile ownership must silence desktop replies here too.
  session.sendDesktopQueryReplyImmediate = (data: string): boolean =>
    session.canSendDesktopQueryReply() && session.transport.sendInputImmediate(data)
  // Gated panes see no subscription bytes; record the fact for later theme flips without replying to subscribe (#9993).
  session.handleHiddenMode2031SubscribeFact = (): void => {
    const ptyId = session.transport.getPtyId()
    if (
      session.disposed ||
      (!session.isHiddenDeliveryGateManagedPty(ptyId) && session.remoteOutputGatedPtyId !== ptyId)
    ) {
      return
    }
    const mode = resolveTerminalColorSchemeMode(
      useAppStore.getState().settings,
      getSystemPrefersDark()
    )
    session.deps.recordPaneMode2031Subscription?.(session.pane.id, mode)
  }
  // Only facts retire gated subscriptions; missing withdrawal bytes would otherwise send theme replies to the replacement shell (#9993).
  session.handleHiddenMode2031UnsubscribeFact = (): void => {
    const ptyId = session.transport.getPtyId()
    if (
      session.disposed ||
      (!session.isHiddenDeliveryGateManagedPty(ptyId) && session.remoteOutputGatedPtyId !== ptyId)
    ) {
      return
    }
    session.deps.paneMode2031Ref.current.delete(session.pane.id)
    session.deps.paneLastThemeModeRef.current.delete(session.pane.id)
  }
  session.deps.paneTransportsRef.current.set(session.pane.id, session.transport)
  session.terminalCapabilityRepliesDisposable = installTerminalCapabilityReplyHandlers({
    terminal: session.pane.terminal,
    parser: session.pane.terminal.parser,
    // Send query replies immediately to beat raw-mode read windows; remote input debounce can corrupt late replies (#7329).
    sendInput: session.sendDesktopQueryReplyImmediate,
    isReplaying: () => isPaneReplaying(session.deps.replayingPanesRef, session.pane.id),
    // Advertise Sixel only after decoder attachment; enabled settings can precede lazy load or survive a failed load.
    sixelSupported: () =>
      resolveTerminalInlineImagesEnabled(useAppStore.getState().settings?.terminalInlineImages) &&
      terminalRendersInlineImages(session.pane.terminal),
    skipOscColorQueryReplies: () => !session.shouldAnswerPaneOscColorQueries(),
    answerProgramStatusQueries: () =>
      !session.runtimeEnvironmentId ||
      readCachedRuntimeEnvironmentCapability(
        session.runtimeEnvironmentId,
        PROGRAM_STATUS_RUNTIME_CAPABILITY
      ) === true,
    ...(session.isNativeWindowsConpty ? { da1Response: CONPTY_DA1_RESPONSE } : {})
  })
  session.respondToTerminalPixelSizeQueries = createTerminalPixelSizeQueryResponder(
    session.pane.terminal,
    session.sendDesktopQueryReplyImmediate
  )

  session.claimViewportForUserActivity = (input?: string): void => {
    const currentPtyId = session.transport.getPtyId()
    if (!currentPtyId || getFitOverrideForPty(currentPtyId)?.mode !== 'remote-desktop-fit') {
      return
    }
    // Focus reports after SIGWINCH are not ownership claims; otherwise different-grid mirrors steal the viewport forever (#26469).
    if (input !== undefined && isPassiveTerminalInputReport(input)) {
      return
    }
    let proposed: { cols: number; rows: number } | undefined
    try {
      proposed = session.pane.fitAddon.proposeDimensions()
    } catch {
      proposed = undefined
    }
    const cols = proposed?.cols ?? session.pane.terminal.cols
    const rows = proposed?.rows ?? session.pane.terminal.rows
    if (cols > 0 && rows > 0) {
      // Keep parked until runtime confirms desktop-fit; queued claims must remain retryable after transient failure.
      session.transport.claimViewport?.(cols, rows)
    }
  }
  session.claimPendingVisibleRemoteViewport = (): void => {
    if (
      !session.pendingVisibleRemoteViewportClaim ||
      !session.deps.isVisibleRef.current ||
      typeof document === 'undefined' ||
      document.visibilityState === 'hidden' ||
      typeof document.hasFocus !== 'function' ||
      !document.hasFocus()
    ) {
      return
    }
    session.claimViewportForUserActivity()
  }
  session.armVisibleRemoteViewportClaim = (): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      session.visibleRemoteViewportClaimPtyId = null
      session.pendingVisibleRemoteViewportClaim = false
      return
    }
    if (
      session.visibleRemoteViewportClaimPtyId !== ptyId ||
      session.pendingVisibleRemoteViewportClaim ||
      getFitOverrideForPty(ptyId)?.mode === 'remote-desktop-fit'
    ) {
      session.visibleRemoteViewportClaimPtyId = ptyId
      session.pendingVisibleRemoteViewportClaim = true
    }
  }
  session.unsubscribeRemoteDesktopActivationClaim = onOverrideChange((event) => {
    if (event.ptyId !== session.transport.getPtyId() || !isRemoteRuntimePtyId(event.ptyId)) {
      return
    }
    if (event.mode === 'desktop-fit') {
      session.visibleRemoteViewportClaimPtyId = event.ptyId
      session.pendingVisibleRemoteViewportClaim = false
      return
    }
    if (event.mode === 'remote-desktop-fit') {
      if (
        session.deps.isVisibleRef.current &&
        session.visibleRemoteViewportClaimPtyId !== event.ptyId
      ) {
        session.visibleRemoteViewportClaimPtyId = event.ptyId
        session.pendingVisibleRemoteViewportClaim = true
      }
      session.claimPendingVisibleRemoteViewport()
    }
  })

  // Live PTYs with detached bindings can reject input while showing cached frames; remount because dead-session checks cannot detect that state (#8104).
  session.transportConnectInFlightSince = null
  session.requestRecoveryForUndeliverableInput = (providerRejected = false): void => {
    if (
      !providerRejected &&
      session.transport.isConnected?.() &&
      session.transport.getPtyId() !== null
    ) {
      return
    }
    // Pending connect rejects are temporary; do not race remount against their live PTY, or against a successor after disposal.
    const connectStillSettling =
      session.transportConnectInFlightSince !== null &&
      Date.now() - session.transportConnectInFlightSince < TRANSPORT_CONNECT_SETTLE_GRACE_MS
    // Why: a transport that is retrying its own binding owns recovery; a remount would race it.
    const transportOwnsRecovery = !providerRejected && session.transport.ownsRecovery?.() === true
    if (connectStillSettling || transportOwnsRecovery || session.disposed) {
      return
    }
    const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
    const undeliverablePtyId = session.transport.getPtyId() ?? storePtyId
    // Local main can prove local/SSH liveness but owns no remote-runtime registry; use the remote host’s rejection instead of fabricated local absence (STA-2830).
    const hostRejectedRemoteInput = providerRejected && isRemoteRuntimePtyId(undeliverablePtyId)
    void requestTerminalPaneRecovery({
      tabId: session.deps.tabId,
      ptyId: undeliverablePtyId,
      reason: hostRejectedRemoteInput ? 'input-rejected-by-host' : 'input-undeliverable',
      terminalRecoveryGeneration: session.terminalRecoveryGeneration,
      terminalRecoveryInstanceId: session.terminalRecoveryInstance.id,
      // Require authoritative remote/SSH liveness so local null results cannot cause repeated typing-driven remounts.
      requireAuthoritativeLiveness:
        Boolean(session.transport.getConnectionId?.()) || isRemoteRuntimePtyId(undeliverablePtyId),
      // Only host rejection can replace the shell and lose a partial line; stalled-pipeline recovery retains that line on the same PTY.
      endpointReplaced: providerRejected,
      // Check all panes at admission: one remount replaces siblings too, and input can arrive during the liveness probe.
      hasUndeliveredInput: () =>
        [...session.deps.paneTransportsRef.current.values()].some(
          (transport) => transport.hasUndeliveredInput?.() === true
        )
    })
  }
  // Route dead-pipeline certification through tab recovery; replacing xterm resets its per-instance certification.
  session.unregisterUndeliverableWriteHandler = registerUndeliverableWriteHandler(
    session.pane.terminal,
    (reason) => {
      // Release queued/detached output credit immediately on pipeline death.
      discardTerminalOutput(session.pane.terminal)
      const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
      void requestTerminalPaneRecovery({
        tabId: session.deps.tabId,
        ptyId: session.transport.getPtyId() ?? storePtyId,
        reason,
        terminalRecoveryGeneration: session.terminalRecoveryGeneration,
        terminalRecoveryInstanceId: session.terminalRecoveryInstance.id
      })
    }
  )
}

/** COMPAT(legacy-relay-bridge, revisit 2027-01-15): a pane an older Orca's relay still runs. */
function withLegacyRelayBridge(session: ConnectPanePtySession, inner: PtyTransport): PtyTransport {
  const leafId = session.deps.restoredLeafId ?? session.pane.leafId
  const ptyId = legacyRelayBridgePtyIdForPane({
    tabId: session.deps.tabId,
    leafId,
    boundPtyId:
      (leafId ? session.deps.restoredPtyIdByLeafId?.[leafId] : undefined) ??
      useAppStore
        .getState()
        .tabsByWorktree[session.deps.worktreeId]?.find((tab) => tab.id === session.deps.tabId)
        ?.ptyId
  })
  session.legacyRelayBridgePtyId = ptyId
  return ptyId ? createLegacyRelayBridgeTransport(ptyId, inner) : inner
}
