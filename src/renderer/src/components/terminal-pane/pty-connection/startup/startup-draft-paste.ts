import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { isAgentForegroundProcess } from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../../shared/agent-launch/startup/readiness/draft-paste-ready-timeout'
import { createDraftPasteReadyScanner } from '../../../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'
import {
  createSetupWaitGate,
  SETUP_WAIT_GATE_MAX_MS
} from '../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
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
  const createStartupDraftReadyScanner = (): ReturnType<typeof createDraftPasteReadyScanner> =>
    createDraftPasteReadyScanner(
      session.startupDraftAgentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
    )
  let startupDraftReadyScanner = session.ownsStartupDraftPaste
    ? createStartupDraftReadyScanner()
    : null
  // A wait-for-setup pane's Setup time does not count toward the draft deadline.
  const setupWaitGate = createSetupWaitGate()
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
    const agent = session.startupDraftAgent
    if (!agent || startupDraftPasteSettled) {
      return
    }
    const ptyId = getStartupDraftPtyId()
    if (!ptyId) {
      return
    }
    try {
      const process = await inspectRuntimeTerminalProcess(ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (getStartupDraftPtyId() === ptyId && isAgentForegroundProcess(foreground, agent)) {
        sendStartupDraftPaste()
      }
    } catch {
      // Best-effort fallback; the primary path is the PTY readiness marker.
    }
  }
  /** Settles without pasting and tells the user their notes weren't sent. */
  const abandonStartupDraft = (): void => {
    startupDraftHardTimer = null
    const agent = session.startupDraftAgent
    if (!getStartupDraftPtyId() || !agent) {
      return
    }
    startupDraftPasteSettled = true
    // A timed-out launch stays consumed across pane disposal and remount.
    session.startupDraftPasteAttempted = true
    session.cleanupStartupDraftPasteTimers()
    createPasteReadinessTimeoutNotice({
      worktreeId: session.deps.worktreeId,
      tabId: session.deps.tabId,
      agent,
      submitted: false
    }).onTimeout()
  }
  const onStartupDraftDeadline = (): void => {
    if (session.startupDraftAgent === 'codex') {
      return abandonStartupDraft()
    }
    startupDraftHardTimer = null
    if (getStartupDraftPtyId()) {
      void deliverStartupDraftIfAgentOwnsPty()
    }
  }
  const armStartupDraftHardTimer = (
    ms = resolveDraftPasteReadyTimeoutMs(session.startupDraftAgent),
    onDeadline = onStartupDraftDeadline
  ): void => {
    if (!startupDraftReadyScanner || startupDraftPasteSettled || startupDraftHardTimer !== null) {
      return
    }
    startupDraftHardTimer = setTimeout(onDeadline, ms)
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
    const gated = setupWaitGate.observe(data)
    if (gated.phase) {
      // Output before Setup ended was the wrapper's, so the scan and timers start over.
      startupDraftReadyScanner = createStartupDraftReadyScanner()
      clearStartupDraftPasteTimers()
      if (gated.phase === 'failed') {
        // No agent will start, so later shell output must never receive the draft.
        return abandonStartupDraft()
      }
      if (gated.phase === 'waiting') {
        // Past the wrapper's own Setup limit no agent can start.
        return armStartupDraftHardTimer(SETUP_WAIT_GATE_MAX_MS, abandonStartupDraft)
      }
      armStartupDraftHardTimer()
    }
    const scanned = startupDraftReadyScanner.observe(gated.output)
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
