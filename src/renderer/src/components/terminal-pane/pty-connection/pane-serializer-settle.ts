import { useAppStore } from '@/store'
import type { SessionRestoredBannerReason } from '../session-restored-banner-pane-state'
import { hasPtySerializer } from '../pty-buffer-serializer'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { isExpectedAgentProcess } from '../../../../../shared/agent-process-recognition'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../shared/draft-paste-ready-timeout'
import { createDraftPasteReadyScanner } from '../../../../../shared/draft-paste-ready-scanner'
import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import { writeTerminalPastePtyInput } from '../terminal-pty-paste-writer'

import { STARTUP_DRAFT_PASTE_QUIET_MS } from './pty-connect-limits'
import { isRemoteRuntimePtyId } from './paired-parked-terminal-restore'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function bindSettlePaneSerializer(session: ConnectPanePtySession): void {
  session.settlePaneSerializerAfterReplay = async (
    ptyId: string,
    generation: number
  ): Promise<void> => {
    try {
      await session.replayWriteQueue
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        await window.api.pty
          .clearPendingPaneSerializer(session.cacheKey, generation)
          .catch(() => {})
        return
      }
      await waitForTerminalOutputParsed(session.pane.terminal)
      if (!session.disposed && session.transport.getPtyId() === ptyId) {
        await window.api.pty.settlePaneSerializer(session.cacheKey, generation)
        return
      }
    } catch {
      // Clear below so a failed parser/replay cannot leave the pane generation pending.
    }
    await window.api.pty.clearPendingPaneSerializer(session.cacheKey, generation).catch(() => {})
  }
  session.reportRemoteRendererSerializerReady = (): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      return
    }
    if (!hasPtySerializer(ptyId)) {
      session.registerPaneSerializerFor(ptyId)
    }
    // Why: onSubscribed follows the snapshot callback, but replay drains
    // asynchronously; join it and xterm's parser before reporting readiness.
    void session.replayWriteQueue
      .then(() => waitForTerminalOutputParsed(session.pane.terminal))
      .then(() => {
        if (!session.disposed && session.transport.getPtyId() === ptyId) {
          void window.api.pty.reportRendererSerializerReady?.(ptyId)
        }
      })
      .catch(() => {})
  }

  // Why: local and ordinary SSH startup commands are provider-owned so delivery
  // survives renderer replacement. Only explicit terminal-paste stays renderer-owned.
  session.pendingStartupCommand = session.shouldDeliverStartupViaTerminalPaste
    ? session.paneStartup?.command
      ? { command: session.paneStartup.command }
      : null
    : null
  const startupDraftReadyScanner = session.ownsStartupDraftPaste
    ? createDraftPasteReadyScanner(
        session.startupDraftAgentConfig?.draftPasteReadySignal ??
          'render-quiet-after-bracketed-paste'
      )
    : null
  let startupDraftReadinessArmed = false
  let startupDraftPasteSettled = !session.ownsStartupDraftPaste
  let startupDraftPasteInFlight = false
  let startupDraftInputRecorded = false
  let startupDraftQuietTimer: ReturnType<typeof setTimeout> | null = null
  let startupDraftHardTimer: ReturnType<typeof setTimeout> | null = null
  const clearStartupDraftPasteTimers = (): void => {
    if (startupDraftQuietTimer !== null) {
      clearTimeout(startupDraftQuietTimer)
      startupDraftQuietTimer = null
    }
    if (startupDraftHardTimer !== null) {
      clearTimeout(startupDraftHardTimer)
      startupDraftHardTimer = null
    }
  }
  session.cleanupStartupDraftPasteTimers = clearStartupDraftPasteTimers
  const getStartupDraftPtyId = (): string | null => {
    const ptyId = session.transport.getPtyId()
    if (
      !ptyId ||
      session.disposed ||
      session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
    ) {
      return null
    }
    return ptyId
  }
  const sendStartupDraftPaste = (): void => {
    if (
      !session.startupDraftPrompt ||
      startupDraftPasteSettled ||
      startupDraftPasteInFlight ||
      !startupDraftReadinessArmed
    ) {
      return
    }
    const ptyId = getStartupDraftPtyId()
    if (!ptyId) {
      return
    }
    startupDraftPasteInFlight = true
    startupDraftPasteSettled = true
    session.startupDraftPasteAttempted = true
    session.cleanupStartupDraftPasteTimers()
    const settings = getSettingsForWorktreeRuntimeOwner(
      useAppStore.getState(),
      session.deps.worktreeId
    )
    // Why: xterm focus reports share this transport queue. Bypassing it can
    // race CSI I against the draft on ConPTY and expose a literal `[I` prefix.
    void sendAgentDraftPasteContent(settings, ptyId, session.startupDraftPrompt, async (data) => {
      const accepted = await writeTerminalPastePtyInput(session.transport, data)
      if (accepted && !startupDraftInputRecorded) {
        // Why: this transport write bypasses xterm's user-input signal; keep
        // the composed draft from being discarded by later hibernation.
        startupDraftInputRecorded = true
        session.recordTerminalInputForHibernation()
      }
      return accepted
    })
      .catch(() => false)
      .finally(() => {
        startupDraftPasteInFlight = false
      })
  }
  const deliverStartupDraftIfAgentOwnsPty = async (): Promise<void> => {
    if (!session.startupDraftAgentConfig || startupDraftPasteSettled) {
      return
    }
    const ptyId = getStartupDraftPtyId()
    if (!ptyId) {
      return
    }
    const settings = getSettingsForWorktreeRuntimeOwner(
      useAppStore.getState(),
      session.deps.worktreeId
    )
    try {
      const process = await inspectRuntimeTerminalProcess(settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (
        getStartupDraftPtyId() === ptyId &&
        isExpectedAgentProcess(foreground, session.startupDraftAgentConfig.expectedProcess)
      ) {
        sendStartupDraftPaste()
      }
    } catch {
      // Best-effort fallback; the primary path is the PTY readiness marker.
    }
  }
  const armStartupDraftHardTimer = (): void => {
    if (!startupDraftReadyScanner || startupDraftPasteSettled || startupDraftHardTimer !== null) {
      return
    }
    startupDraftHardTimer = setTimeout(() => {
      startupDraftHardTimer = null
      void deliverStartupDraftIfAgentOwnsPty()
    }, resolveDraftPasteReadyTimeoutMs(session.startupDraftAgent))
  }
  const armStartupDraftQuietTimer = (): void => {
    if (!startupDraftReadyScanner || startupDraftPasteSettled) {
      return
    }
    if (startupDraftQuietTimer !== null) {
      clearTimeout(startupDraftQuietTimer)
    }
    startupDraftQuietTimer = setTimeout(() => {
      startupDraftQuietTimer = null
      sendStartupDraftPaste()
    }, STARTUP_DRAFT_PASTE_QUIET_MS)
  }
  session.armStartupDraftReadinessObservation = (): void => {
    if (!startupDraftReadyScanner || startupDraftReadinessArmed) {
      return
    }
    startupDraftReadinessArmed = true
    armStartupDraftHardTimer()
  }
  session.observeStartupDraftPasteReadiness = (data: string): void => {
    if (!startupDraftReadyScanner || !startupDraftReadinessArmed || startupDraftPasteSettled) {
      return
    }
    const scanned = startupDraftReadyScanner.observe(data)
    if (scanned.ready) {
      sendStartupDraftPaste()
      return
    }
    if (scanned.armQuietTimer) {
      armStartupDraftQuietTimer()
    }
  }
  if (
    session.ownsStartupDraftPaste &&
    !session.connectionId &&
    !session.shouldDeliverStartupViaTerminalPaste
  ) {
    session.armStartupDraftReadinessObservation()
  }
  let sessionRestoredBannerShown: SessionRestoredBannerReason | null = null
  session.showSessionRestoredBanner = (reason: SessionRestoredBannerReason = 'restored'): void => {
    // Why: a plain 'restored' banner must not latch out the later 'resume-unavailable'
    // upgrade — the pane would keep claiming a session it never got back.
    if (
      sessionRestoredBannerShown === reason ||
      sessionRestoredBannerShown === 'resume-unavailable'
    ) {
      return
    }
    sessionRestoredBannerShown = reason
    session.deps.onShowSessionRestoredBanner(session.pane.id, reason)
  }
}
