import { isSessionRestartRefusedBeforeStop } from '../../../shared/session-restart-refusal'

/** Fields main already returns from pty.spawn. A new id alone is not a restored session. */
export type AgentResumeRefusal = 'chat-home' | 'chat-writing' | 'unverifiable'

/** Fields main already returns from pty.spawn. Echoed resume metadata is not provider confirmation. */
export type AgentSessionRestartSpawnResult = {
  id?: string
  isReattach?: boolean
  agentResumeUnavailable?: true
  agentResumeRefused?: AgentResumeRefusal
  sessionExpired?: boolean
  resumeProviderSession?: { id?: string } | null
  /** The launch was postponed. This is not a started process and not a failure. */
  deferred?: true
  /** Main rejected the restart before stopping the old process. */
  refusedBeforeStop?: true
}

export type AgentSessionRestartVerdict =
  | { ok: true; ptyId: string }
  | { ok: false; message: string; reapPtyId: string | null }

export type AgentSessionRestartSettlementSource = {
  onSessionRestartSettled?: (result: AgentSessionRestartSpawnResult | null) => void
}

export function sessionRestartCatchResult(error: unknown): AgentSessionRestartSpawnResult | null {
  return isSessionRestartRefusedBeforeStop(error) ? { refusedBeforeStop: true } : null
}

export function createSessionRestartNotifier(
  readStartup: () => AgentSessionRestartSettlementSource | null | undefined
): (result: AgentSessionRestartSpawnResult | null) => void {
  const startup = readStartup()
  const once = { notified: false }
  return (result) => {
    settleAgentSessionRestart(startup, result, once)
  }
}

/** Invoke a renderer-only restart callback once. A missing callback is a no-op. */
export function settleAgentSessionRestart(
  startup: AgentSessionRestartSettlementSource | null | undefined,
  result: AgentSessionRestartSpawnResult | null,
  once: { notified: boolean }
): void {
  if (once.notified || !startup || !('onSessionRestartSettled' in startup)) {
    return
  }
  const notify = startup.onSessionRestartSettled
  if (typeof notify !== 'function') {
    return
  }
  once.notified = true
  try {
    notify(result)
  } catch {
    // Reporting the restart must not change the spawn that already finished.
  }
}

function resumeRefusedMessage(reason: string): string {
  return `the resume was refused (${reason})`
}

const NOT_STARTED = 'the new process did not start'
const KEPT_EXISTING = 'the existing process was kept'
const NOT_ACCEPTED = 'the resume command was not accepted, so the new process was stopped'

/**
 * A new id is a started process, not proof the provider restored the session.
 * Main echoes the requested resume metadata and clears it when it falls back to a fresh chat.
 */
export function judgeAgentSessionRestartSpawn(
  requestedSessionId: string,
  result: AgentSessionRestartSpawnResult | null | undefined
): AgentSessionRestartVerdict {
  const ptyId = typeof result?.id === 'string' && result.id.trim().length > 0 ? result.id : null
  if (!result || result.deferred || !ptyId) {
    return { ok: false, message: NOT_STARTED, reapPtyId: null }
  }
  if (result.isReattach === true) {
    return { ok: false, message: KEPT_EXISTING, reapPtyId: null }
  }
  if (result.agentResumeRefused) {
    return {
      ok: false,
      message: resumeRefusedMessage(result.agentResumeRefused),
      reapPtyId: ptyId
    }
  }
  if (result.agentResumeUnavailable || result.sessionExpired) {
    return { ok: false, message: NOT_ACCEPTED, reapPtyId: ptyId }
  }
  // A missing or different resume id means main started something other than the requested session.
  if (result.resumeProviderSession?.id !== requestedSessionId) {
    return { ok: false, message: NOT_ACCEPTED, reapPtyId: ptyId }
  }
  return { ok: true, ptyId }
}
