import { useAppStore } from '@/store'
import { createIpcPtyTransport } from '../pty-transport'
import { createRemoteRuntimePtyTransport } from '../remote-runtime-pty-transport'
import { toAgentLaunchPreferences } from '@/runtime/agent-session-create-operation'
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
import {
  CONPTY_DA1_RESPONSE,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers
} from '../terminal-capability-replies'

import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { TRANSPORT_CONNECT_SETTLE_GRACE_MS } from './pty-connect-limits'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Transport creation, terminal capability replies, viewport claims, and undeliverable-input recovery. */
export function installPtyInputRecovery(session: ConnectPanePtySession): void {
  session.markAcceptedTerminalInputSent = (): void => {
    session.markTerminalInputSent()
    session.recordTerminalInputForHibernationFallback()
  }
  session.terminalTheme = session.pane.terminal.options.theme
  session.terminalColorQueryReplies = session.terminalTheme
    ? { foreground: session.terminalTheme.foreground, background: session.terminalTheme.background }
    : undefined
  session.agentLaunchPreferences = toAgentLaunchPreferences(session.paneStartup?.sessionOptions)
  session.transportOptions = {
    cwd: session.deps.cwd,
    ...(session.deps.cwdPromise || session.deps.preconnectInput?.length
      ? { bufferInputUntilConnect: true }
      : {}),
    ...(session.deps.preconnectInput?.length
      ? { preconnectInput: session.deps.preconnectInput }
      : {}),
    ...(session.deps.onPreconnectInput
      ? { onPreconnectInput: session.deps.onPreconnectInput }
      : {}),
    // Why: only fresh local IPC spawns may recover from a saved startup cwd
    // whose directory was deleted (#7239); remote-runtime and SSH spawns
    // resolve cwd on another host and must keep exact cwd semantics.
    ...(session.runtimeEnvironmentId === null && !session.connectionId
      ? { cwdFallback: 'worktree' as const }
      : {}),
    env: session.paneEnv,
    ...(session.paneStartup?.envToDelete ? { envToDelete: session.paneStartup.envToDelete } : {}),
    command: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.command,
    ...(session.shouldUseProviderSshStartupDelivery
      ? { commandDelivery: 'provider' as const }
      : {}),
    startupCommandDelivery: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.connectionId && session.paneStartup?.command
        ? 'shell-ready'
        : session.paneStartup?.startupCommandDelivery,
    connectionId: session.connectionId,
    executionHostId: session.executionHostId,
    worktreeId: session.deps.worktreeId,
    // Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
    // main sync-flush the (worktreeId, tabId, leafId → ptyId) binding before
    // pty:spawn returns. Daemon-host-only: SSH path leaves these undefined
    // and the main-side guard short-circuits.
    tabId: session.deps.tabId,
    leafId: session.pane.leafId,
    activate: session.deps.isActiveRef.current && session.deps.isVisibleRef.current,
    ...(session.shellOverride ? { shellOverride: session.shellOverride } : {}),
    ...(session.projectRuntime ? { projectRuntime: session.projectRuntime } : {}),
    ...(session.terminalColorQueryReplies
      ? { terminalColorQueryReplies: session.terminalColorQueryReplies }
      : {}),
    ...(session.paneStartup?.launchConfig
      ? { launchConfig: session.paneStartup.launchConfig }
      : {}),
    ...(session.paneStartup?.resumeProviderSession
      ? { resumeProviderSession: session.paneStartup.resumeProviderSession }
      : {}),
    ...((session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt)
      ? {
          agentPrompt:
            session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt
        }
      : {}),
    ...(session.paneStartup?.initialAgentStatus?.prompt
      ? { agentPromptDelivery: 'auto-submit' as const }
      : session.paneStartup?.draftPrompt
        ? { agentPromptDelivery: 'draft' as const }
        : {}),
    ...(session.paneStartup?.agentArgsOverride !== undefined
      ? { agentArgsOverride: session.paneStartup.agentArgsOverride }
      : {}),
    ...(session.agentLaunchPreferences
      ? { agentLaunchPreferences: session.agentLaunchPreferences }
      : {}),
    ...(session.launchToken ? { launchToken: session.launchToken } : {}),
    ...(session.paneStartup?.launchAgent ? { launchAgent: session.paneStartup.launchAgent } : {}),
    ...(session.paneStartup?.telemetry ? { telemetry: session.paneStartup.telemetry } : {}),
    onPtyExit: session.onExit,
    onPtySpawn: session.onPtySpawn,
    onPtyRebind: session.onPtyRebind,
    ...(session.mainSideEffectAuthority
      ? {}
      : {
          onTitleChange: session.onTitleChange,
          onBell: session.onBell,
          onAgentBecameIdle: session.onAgentBecameIdle,
          onAgentBecameWorking: session.onAgentBecameWorking,
          onAgentExited: session.onAgentExited
        }),
    // Why: local IPC terminals are now model-owned in main: OrcaRuntimeService
    // parses OSC 9999 before renderer delivery and forwards through the hook
    // server with local/SSH identity. Remote-runtime streams do not pass through
    // local main, so the renderer remains their status owner for now.
    ...(session.shouldOwnAgentStatusInRenderer
      ? { onAgentStatus: session.handleRendererOwnedAgentStatus }
      : {})
  }
  if (session.connectionOwnerHydrating) {
    // Why: this pane holds an inert transport until its host resolves; register it so
    // the repos:changed handler remounts it instead of leaving the terminal blank.
    recordTerminalTabParkedOnUnresolvedHost(session.deps.worktreeId, session.deps.tabId)
  }
  session.transport =
    session.terminalOwnerUnresolved || session.connectionOwnerHydrating
      ? createUnresolvedOwnerPtyTransport(
          session.terminalOwnerUnresolved
            ? 'Workspace identity is ambiguous across hosts. Refresh projects and try again.'
            : 'Workspace host is still loading. Retry when the project finishes hydrating.'
        )
      : session.runtimeEnvironmentId
        ? createRemoteRuntimePtyTransport(session.runtimeEnvironmentId, session.transportOptions)
        : createIpcPtyTransport(session.transportOptions)
  session.canSendDesktopQueryReply = (): boolean => {
    const ptyId = session.transport.getPtyId()
    return !ptyId || !isPtyLocked(ptyId)
  }
  // Why: parser/capability handlers bypass the ordinary onData guard. Keep
  // desktop silent while the elected mobile xterm owns query replies.
  session.sendDesktopQueryReplyImmediate = (data: string): boolean =>
    session.canSendDesktopQueryReply() && session.transport.sendInputImmediate(data)
  // Why (gate mode only): gate-managed PTYs never see the subscribe bytes, so this fact is
  // their only cue to record the subscription — without the registry entry a later theme
  // flip never pushes the CSI 997 update and the TUI keeps a stale theme after reveal.
  // Record-only: a subscribe is not a query (see session.observeLiveMode2031Chunk, #9993).
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
  // Why (gate mode only): the counterpart to the subscribe fact. These panes never
  // receive the withdrawal bytes — main drops them before delivery — and the chunk
  // scanner is disabled for them, so this fact is the ONLY observer that can retire
  // the subscription. Without it a TUI that exits while hidden leaves paneMode2031
  // set, and the next theme flip pushes CSI 997 into the shell that replaced it
  // (#9993 via maybePushMode2031Flip).
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
    // Why: OSC 10/11 + DA1 replies must beat the querying program's raw-mode
    // read window; the remote transport's input debounce would corrupt them
    // (#7329), so send immediately.
    sendInput: session.sendDesktopQueryReplyImmediate,
    isReplaying: () => isPaneReplaying(session.deps.replayingPanesRef, session.pane.id),
    ...(session.isNativeWindowsConpty ? { da1Response: CONPTY_DA1_RESPONSE } : {})
  })
  session.respondToTerminalPixelSizeQueries = createTerminalPixelSizeQueryResponder(
    session.pane.terminal,
    session.sendDesktopQueryReplyImmediate
  )

  session.claimViewportForUserActivity = (): void => {
    const currentPtyId = session.transport.getPtyId()
    if (!currentPtyId || getFitOverrideForPty(currentPtyId)?.mode !== 'remote-desktop-fit') {
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
      // Why: queuing a claim is not convergence. Keep the pane parked until the
      // runtime confirms desktop-fit so a transient resize failure retries.
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

  // Why: an unbound transport (detached during a remount/move and never
  // rebound) silently rejects every keystroke while the PTY stays alive and
  // the last frame stays painted — the pane looks healthy and eats input
  // (issue #8104 class). None of the dead-session reconciles cover it because
  // the PTY is live; recover by remounting the tab over the live PTY.
  session.transportConnectInFlightSince = null
  session.requestRecoveryForUndeliverableInput = (providerRejected = false): void => {
    if (
      !providerRejected &&
      session.transport.isConnected?.() &&
      session.transport.getPtyId() !== null
    ) {
      return
    }
    // Why: input rejected while a connect/reattach is still settling is "not
    // deliverable YET", not a dead binding. Remounting here destroys the
    // unbound transport, and pty-transport's destroyed check then kills the
    // PTY the in-flight reattach resolves to — the live shell recovery exists
    // to preserve. The fossil case this detector targets has no pending
    // connect, so it still recovers. Same for a late async reject landing
    // after dispose: the successor pane owns the tab now.
    const connectStillSettling =
      session.transportConnectInFlightSince !== null &&
      Date.now() - session.transportConnectInFlightSince < TRANSPORT_CONNECT_SETTLE_GRACE_MS
    if (connectStillSettling || session.disposed) {
      return
    }
    const storePtyId = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId]?.[0] ?? null
    const undeliverablePtyId = session.transport.getPtyId() ?? storePtyId
    // Why the split: for a local (daemon/app-SSH) id main's registry can answer,
    // and a `false` there means the shell really died — the dead-session
    // reconcile owns that teardown and a remount would race it. For a `remote:`
    // id main owns no registry entry, so `pty:hasPty` routes to the local
    // provider and fabricates "dead"; that answer blocked every recovery this
    // signal exists to trigger (STA-2830). The host's own rejection replaces it.
    const hostRejectedRemoteInput = providerRejected && isRemoteRuntimePtyId(undeliverablePtyId)
    void requestTerminalPaneRecovery({
      tabId: session.deps.tabId,
      ptyId: undeliverablePtyId,
      reason: hostRejectedRemoteInput ? 'input-rejected-by-host' : 'input-undeliverable',
      terminalRecoveryGeneration: session.terminalRecoveryGeneration,
      terminalRecoveryInstanceId: session.terminalRecoveryInstance.id,
      // Why: pty:hasPty answers null for ids the local registry doesn't own,
      // and a disconnected remote pane would otherwise remount-churn on every
      // cooldown window while typing. Local panes keep the lenient gate.
      requireAuthoritativeLiveness:
        Boolean(session.transport.getConnectionId?.()) || isRemoteRuntimePtyId(undeliverablePtyId),
      // Why only the rejected path: it is the only one whose remount can land on
      // a fresh shell. A stalled-pipeline remount always reattaches to the same
      // shell, so its half-typed line is still on screen and intact.
      endpointReplaced: providerRejected
    })
  }
  // Why: the write-pipeline health watch (scheduler stall probe, replay-guard
  // wedge certification) detects a dead xterm pipeline; route its verdict to
  // the same tab remount. Registered per xterm instance — recovery replaces
  // the instance, which resets certification naturally.
  session.unregisterUndeliverableWriteHandler = registerUndeliverableWriteHandler(
    session.pane.terminal,
    (reason) => {
      // Certification can arrive while this terminal still owns queued or
      // detached scheduler work; release its delivery credits immediately.
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
