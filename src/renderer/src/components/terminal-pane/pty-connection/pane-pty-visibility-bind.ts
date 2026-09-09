import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
// Why: a restored pane's stale-account prompt can only be raised once a PTY is
// actually attached — nothing is inspectable while the session hydrates.
import { notifyCodexPaneBoundForStaleSweep } from '@/lib/codex-stale-pane-sweep'
import { createTerminalGitHubPRLinkDetector } from '../../../../../shared/terminal-github-pr-link-detector'
import { setRendererPtyVisibilityClaim } from '../pty-renderer-delivery-claims'
import { AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS } from '../agent-task-complete-policy'

import {
  isAgentTaskCompleteNotificationEnabled,
  isAgentTaskCompleteTrackingEnabled
} from './agent-task-complete-settings'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'
import { shouldIgnoreStalePanePtyLayoutBinding } from './pane-pty-layout-binding'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** PTY visibility reporting, active-PTY binding, and the spawn/rebind/bell handlers that follow it. */
export function installPanePtyVisibilityBind(session: ConnectPanePtySession): void {
  session.observeTerminalGitHubPRLink = createTerminalGitHubPRLinkDetector()
  session.reportPanePtyVisibility = (ptyId: string | null | undefined, visible: boolean): void => {
    if (!ptyId || isRemoteRuntimePtyId(ptyId)) {
      // Why: remote-runtime PTYs use a relay path outside main's local
      // renderer-visibility registry, so reporting them here is misleading.
      return
    }
    setRendererPtyVisibilityClaim(session.transport, ptyId, visible)
  }
  session.bindActivePanePty = (
    ptyId: string,
    options: {
      seedInitialAgentStatus?: boolean
      updateTabPtyId?: 'always' | 'if-missing'
      replacePtyId?: string
      sampleVisibleForegroundAgent?: boolean
    } = {}
  ): boolean => {
    // A disposed pane can still receive an already-queued transport callback; it no longer owns state.
    if (session.disposed) {
      return false
    }
    const state = useAppStore.getState()
    const leafId = session.pane.leafId
    const existingPtyId = leafId
      ? state.terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[leafId]
      : undefined
    const tabPtyId = Object.values(state.tabsByWorktree)
      .flat()
      .find((tab) => tab.id === session.deps.tabId)?.ptyId
    // A remounted mirrored pane can report a fresh spawn while its tab still
    // carries the previous host handle. Treat that as an in-place replacement
    // so the old identity cannot remain beside the new one in the tab PTY map.
    const inferredReplacementPtyId =
      existingPtyId && existingPtyId !== ptyId && tabPtyId === existingPtyId
        ? existingPtyId
        : undefined
    const replacementPtyId = options.replacePtyId ?? inferredReplacementPtyId
    if (!options.replacePtyId) {
      const activePtyId = session.activePanePtyBinding
      const isCurrentPaneTransport =
        session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
      const isStaleTransportBinding =
        !isCurrentPaneTransport || (activePtyId !== null && session.transport.getPtyId() !== ptyId)
      const isInitialCurrentTransportBinding = isCurrentPaneTransport && activePtyId === null
      if (
        isStaleTransportBinding ||
        (shouldIgnoreStalePanePtyLayoutBinding({
          existingPtyId,
          nextPtyId: ptyId,
          tabPtyId
        }) &&
          !isInitialCurrentTransportBinding)
      ) {
        return false
      }
    }
    session.bindProcessExitState(ptyId, replacementPtyId)
    if (session.activePanePtyBinding && session.activePanePtyBinding !== ptyId) {
      session.reportPanePtyVisibility(session.activePanePtyBinding, false)
    }
    session.setPanePtyFitBinding(ptyId)
    session.activePanePtyBinding = ptyId
    session.reportPanePtyVisibility(ptyId, session.deps.isVisibleRef.current)
    // Why: record bind time on the spawn/attach chokepoint so the reconcile
    // guard knows this binding is newer than any pre-bind snapshot.
    session.activePanePtyBindingBoundAt = performance.now()
    session.registerSideEffectFactConsumerForPty(ptyId)
    session.syncHiddenRendererPtyDelivery()
    // A live bind proves this pane is current again after detach/reattach.
    useAppStore.getState().restoreAgentPaneAuthority?.(session.cacheKey)
    notifyCodexPaneBoundForStaleSweep(ptyId)
    const tabPtyIds = useAppStore.getState().ptyIdsByTabId?.[session.deps.tabId] ?? []
    const directSshRetryAttemptId =
      session.capturedDirectSshRetryPtyAccepted && session.directSshRetryAttempt
        ? session.directSshRetryAttempt.attemptId
        : undefined
    const updateTabPtyBinding = (): void => {
      if (directSshRetryAttemptId) {
        session.deps.updateTabPtyId(
          session.deps.tabId,
          ptyId,
          replacementPtyId,
          directSshRetryAttemptId
        )
      } else if (replacementPtyId) {
        session.deps.updateTabPtyId(session.deps.tabId, ptyId, replacementPtyId)
      } else {
        session.deps.updateTabPtyId(session.deps.tabId, ptyId)
      }
    }
    const shouldUpdateTabPtyId =
      directSshRetryAttemptId ||
      options.updateTabPtyId !== 'if-missing' ||
      !tabPtyIds.includes(ptyId)
    if (replacementPtyId) {
      // Replacement updates the tab and pane ownership in one store commit;
      // this follow-up is a no-op in production but keeps non-store test deps
      // and pane-local bookkeeping in sync.
      if (shouldUpdateTabPtyId) {
        updateTabPtyBinding()
      }
      session.syncPanePtyLayoutBinding(ptyId)
    } else {
      if (shouldUpdateTabPtyId) {
        updateTabPtyBinding()
      }
      // Publish the tab identity first so a late layout callback cannot leave a tab and pane split.
      session.syncPanePtyLayoutBinding(ptyId)
    }
    if (session.paneStartup && !session.startupPtyBound) {
      // Settles the captured one-shot startup only after this pane owns a concrete PTY.
      session.startupPtyBound = true
      session.deps.onStartupBound?.()
    }
    if (options.seedInitialAgentStatus) {
      session.applyInitialAgentStatus()
    }
    // Spawn/attach completion is when a pane gains a concrete PTY ID. The initial
    // frame-level sync often runs before that async result arrives.
    scheduleRuntimeGraphSync()
    session.agentCompletionCoordinator.startProcessTracking()
    // Why: fresh spawns normally rely on a future OSC 133 command-start read to
    // identify the launched agent; only adopted or restored PTYs may already be
    // inside Codex with no new foreground signal. But no-OSC shells (Git Bash,
    // cmd.exe) never emit a command-start, so an expected-agent pane spawned into
    // one would never gain fresh evidence authorizing trusted Windows CSI-u
    // routing for the launched agent, so Shift+Enter could submit (#7620, #9703).
    // Seed the SAME command-start confirmation the manually-typed launch path
    // uses (onCommandStarted): its bounded retry ladder spans agent boot, and a
    // miss publishes shellForeground:false — recoverable by later focus/reveal
    // samples. A visible-pty sample would instead let a slow boot latch a
    // known-agent shell-confirm that clears launch identity and blocks recovery.
    // A real OSC 133;C, if it arrives, simply supersedes this.
    if (options.sampleVisibleForegroundAgent === true) {
      session.sampleVisiblePaneForegroundAgent()
    } else if (options.seedInitialAgentStatus === true) {
      const freshSpawnLaunchAgent = session.resolveExpectedLaunchTuiAgent()
      if (freshSpawnLaunchAgent) {
        session.paneForegroundAgentTracker.onCommandStarted(freshSpawnLaunchAgent)
      }
    }
    return true
  }

  session.onPtySpawn = (ptyId: string): void => {
    if (!session.claimCapturedDirectSshRetryPty(ptyId)) {
      // Why: this callback proves a fresh process was created, so rejecting its obsolete lease must also retire it.
      queueMicrotask(() => {
        if (session.transport.getPtyId() === ptyId) {
          session.transport.disconnect()
        }
      })
      return
    }
    // Why: record that this exact PTY was freshly spawned (not reattached), so a
    // newborn shell that dies before any interaction (e.g. failing direnv on a
    // just-created worktree) can be kept visible rather than tearing down the
    // worktree. Reattach/coldRestore skip onPtySpawn (pty-transport.ts).
    session.spawnedFreshPtyId = ptyId
    // Why: Command Code has no prompt-start hook. Seed the visible working row
    // once the PTY exists, then let real hook events refine or complete it.
    const bound = session.bindActivePanePty(ptyId, { seedInitialAgentStatus: true })
    if (!bound) {
      // A stale transport may report a spawn after a successor claimed this
      // pane slot. Its one-shot startup belongs to the successor, not here.
      return
    }
    // Spend queued startup only after this pane owns a concrete PTY.
    try {
      session.deps.onQueuedStartupSpawned?.()
    } catch {
      // Do not strand a successful spawn because a delivery callback failed.
    }
  }
  session.onPtyRebind = (
    ptyId: string,
    replacedPtyId: string,
    incarnationId?: string | null
  ): void => {
    if (session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport) {
      return
    }
    if (!session.canAdoptCapturedDirectSshRetryPty(ptyId)) {
      return
    }
    session.remotePtyIncarnationId = incarnationId ?? null
    // Why: provider handle rotation keeps the existing pane/session generation;
    // replace its stale store identity without fresh-spawn exit semantics.
    session.bindActivePanePty(ptyId, { replacePtyId: replacedPtyId })
  }
  // ─── Attention signal: BEL ────────────────────────────────────────────
  //
  // BEL (0x07) is the attention signal. A BEL raises tab- and worktree-level
  // indicators, and fires an OS notification. The experimental pane marker
  // clears when the user interacts with the exact pane.
  //
  // The one case where BEL falsely fires is when a crashed TUI left DEC
  // private mode 1004 (focus event reporting) enabled — pane clicks then
  // emit `\e[I`/`\e[O` into the shell, zsh treats them as unbound keys and
  // rings the bell. This is specific to terminals with cross-restart
  // persistence (as we have); our fix is to reset 1004 and friends after
  // scrollback replay so the mode state matches the fresh shell
  // underneath. See POST_REPLAY_MODE_RESET in shared/terminal-mode-reset-profiles.ts.
  session.onBell = (): void => {
    // Why: restored Claude Code sessions have been observed to emit a real
    // standalone BEL some time after daemon snapshot reattach, even when Orca
    // did not just forward focus/control input. Treat the BEL as authoritative
    // PTY output here; any product-side suppression should be an explicit UX
    // decision higher up, not a transport-layer guess.
    session.deps.markWorktreeUnread(session.deps.worktreeId)
    session.deps.markTerminalTabUnread(session.deps.tabId)
    if (useAppStore.getState().settings?.experimentalTerminalAttention === true) {
      session.deps.markTerminalPaneUnread(session.cacheKey)
    }
    // Why: agent CLIs often emit BEL in the same completion burst as their
    // working->idle title change. Delay only the OS notification so the richer
    // agent-complete notification can win the main-process worktree cooldown.
    session.pendingTerminalBellNotification = true
    if (!session.hasPendingAgentTaskCompleteNotification()) {
      session.scheduleTerminalBellNotification()
    }
  }

  session.clearTerminalBellNotificationTimer = (): void => {
    if (session.terminalBellNotificationTimer !== null) {
      clearTimeout(session.terminalBellNotificationTimer)
      session.terminalBellNotificationTimer = null
    }
  }

  session.scheduleTerminalBellNotification = (): void => {
    if (session.terminalBellNotificationTimer !== null) {
      return
    }
    session.terminalBellNotificationTimer = setTimeout(() => {
      session.terminalBellNotificationTimer = null
      if (session.disposed) {
        session.pendingTerminalBellNotification = false
        return
      }
      if (session.hasPendingAgentTaskCompleteNotification()) {
        return
      }
      session.pendingTerminalBellNotification = false
      session.deps.dispatchNotification({ source: 'terminal-bell', paneKey: session.cacheKey })
    }, AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS)
  }

  session.hasPendingAgentTaskCompleteNotification = (): boolean =>
    isAgentTaskCompleteNotificationEnabled() &&
    (session.agentCompletionCoordinator.hasPendingHookDoneCompletion() ||
      session.agentTaskCompleteNotificationGraceTimer !== null ||
      session.agentTaskCompleteNotificationMaxTimer !== null ||
      session.agentTaskCompleteStatusUnsubscribe !== null)

  session.clearPendingAgentTaskCompleteNotification = (): void => {
    if (session.agentTaskCompleteNotificationGraceTimer !== null) {
      clearTimeout(session.agentTaskCompleteNotificationGraceTimer)
      session.agentTaskCompleteNotificationGraceTimer = null
    }
    if (session.agentTaskCompleteNotificationMaxTimer !== null) {
      clearTimeout(session.agentTaskCompleteNotificationMaxTimer)
      session.agentTaskCompleteNotificationMaxTimer = null
    }
    if (session.agentTaskCompleteStatusUnsubscribe !== null) {
      session.agentTaskCompleteStatusUnsubscribe()
      session.agentTaskCompleteStatusUnsubscribe = null
    }
  }

  session.syncAgentTaskCompleteTrackingEnabled = (): boolean => {
    const enabled = isAgentTaskCompleteTrackingEnabled()
    const osNotificationsEnabled = isAgentTaskCompleteNotificationEnabled()
    if (
      !osNotificationsEnabled &&
      session.wasAgentTaskCompleteOsNotificationEnabled &&
      session.pendingTerminalBellNotification
    ) {
      session.scheduleTerminalBellNotification()
    }
    if (!enabled && session.wasAgentTaskCompleteTrackingEnabled) {
      // Why: disabling every completion consumer is an event-time boundary.
      // Drop pending alerts while preserving accepted-hook lifecycle state.
      session.agentTaskCompleteNotificationGeneration += 1
      session.requiresFreshWorkingForAgentTaskCompleteNotification = true
      session.clearPendingAgentTaskCompleteNotification()
      if (session.pendingTerminalBellNotification) {
        session.scheduleTerminalBellNotification()
      }
    } else if (enabled && !session.wasAgentTaskCompleteTrackingEnabled) {
      // Why: a pane may have observed work while all completion consumers were
      // disabled. Re-enabling should not let the next idle event report old work.
      session.requiresFreshWorkingForAgentTaskCompleteNotification = true
    }
    session.wasAgentTaskCompleteTrackingEnabled = enabled
    session.wasAgentTaskCompleteOsNotificationEnabled = osNotificationsEnabled
    return enabled
  }
}
