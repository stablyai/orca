import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { isExpectedAgentProcess } from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../../shared/draft-paste-ready-timeout'
import { createDraftPasteReadyScanner } from '../../../../../../shared/draft-paste-ready-scanner'
import { sendAgentDraftPasteContent } from '@/lib/agent-session/messaging/paste/agent-draft-paste-content'
import { writeTerminalPastePtyInput } from '../../input/paste/terminal-pty-paste-writer'
import { createPasteReadinessTimeoutNotice } from '@/lib/agent-session/launch/prompt/launch-agent-paste-timeout-notice'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

const STARTUP_DRAFT_PASTE_QUIET_MS = 1500

export function bindStartupDraftPaste(session: ConnectPanePtySession): void {
  // Providers own startup delivery across renderer replacement; only explicit terminal paste stays renderer-owned.
  session.pendingStartupCommand = session.shouldDeliverStartupViaTerminalPaste
    ? session.paneStartup?.command
      ? { command: session.paneStartup.command, resumeSource: session.paneStartup.resumeSource }
      : null
    : null
  const startupSource = session.paneStartup?.resumeSource
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
      startupSource?.cancelled ||
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
    // Share the transport queue with focus replies so ConPTY cannot race CSI I into the draft as a literal prefix.
    void sendAgentDraftPasteContent(ptyId, session.startupDraftPrompt, 'launch', async (data) => {
      if (getStartupDraftPtyId() !== ptyId) {
        return false
      }
      const accepted = await writeTerminalPastePtyInput(session.transport, data, 'launch')
      if (accepted && !startupDraftInputRecorded) {
        // Transport paste bypasses xterm’s input signal; record it so hibernation cannot discard the composed draft.
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
    try {
      const process = await inspectRuntimeTerminalProcess(ptyId)
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
      if (!getStartupDraftPtyId()) {
        return
      }
      if (session.startupDraftAgent === 'codex') {
        startupDraftPasteSettled = true
        // A timed-out launch stays consumed across pane disposal and remount.
        session.startupDraftPasteAttempted = true
        session.cleanupStartupDraftPasteTimers()
        createPasteReadinessTimeoutNotice({
          worktreeId: session.deps.worktreeId,
          tabId: session.deps.tabId,
          agent: 'codex',
          submitted: false
        }).onTimeout()
        return
      }
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
    !session.unservedSshTargetId &&
    !session.shouldDeliverStartupViaTerminalPaste
  ) {
    session.armStartupDraftReadinessObservation()
  }
}
