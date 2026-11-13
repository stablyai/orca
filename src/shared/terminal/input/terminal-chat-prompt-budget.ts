import type { TerminalAgent } from '../../agent-status/identity/terminal-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../agent-launch/catalog/tui-agent-config'
import {
  agentPromptSubmitJoinsPasteFrame,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../agent-launch/startup/agent-prompt-injection'
import { countAgentTuiInputLines } from '../../agent-launch/startup/agent-tui-input-clear'
import { buildNativeChatPasteBytes } from '../../native-chat/input/native-chat-paste-bytes'
import { getTerminalInputByteLength } from './terminal-input'
import { isSafeTimerDelayMs } from '../../timer-delay'

export type TerminalChatExpiry = { runtimeId: string; expiresAtMs: number }
export type ElapsedClockBounds = { lower: number; upper: number }

export function mapTerminalChatExpiry(
  runtimeId: string,
  sampleLower: number,
  callerExpiry: number,
  receiptUpper: number
): TerminalChatExpiry {
  const expiresAtMs = sampleLower + (callerExpiry - receiptUpper)
  if (
    !runtimeId ||
    !Number.isSafeInteger(sampleLower) ||
    sampleLower < 0 ||
    !Number.isSafeInteger(callerExpiry) ||
    !Number.isSafeInteger(receiptUpper) ||
    receiptUpper < 0 ||
    receiptUpper >= callerExpiry ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs < 0
  ) {
    throw new Error('Chat input request expired')
  }
  return { runtimeId, expiresAtMs }
}

export type TerminalChatPromptSchedule = ReturnType<typeof terminalChatPromptSchedule>

export function terminalChatPromptSchedule(text: string) {
  const nativeBytes = getTerminalInputByteLength(buildNativeChatPasteBytes(text))
  const generatedBytes = getTerminalInputByteLength(buildAgentPromptPasteBytes(text))
  const lines = countAgentTuiInputLines(text)
  const ingestMs = (platform: NodeJS.Platform) => getTerminalPasteIngestMs(platform, nativeBytes)
  const submitDelayMs = (platform: NodeJS.Platform, agent: TerminalAgent) => {
    const config = isTuiAgent(agent) ? TUI_AGENT_CONFIG[agent] : undefined
    return getAgentPromptSubmitDelayMs(platform, generatedBytes, {
      lineCount: lines,
      lineSettleMsPerLine: config?.submitLineSettleMsPerLine
    })
  }
  const scheduleMs = (platform: NodeJS.Platform, agent: TerminalAgent, renderGate: boolean) =>
    agentPromptSubmitJoinsPasteFrame(agent)
      ? 0
      : (renderGate ? 16000 + ingestMs(platform) : 0) + submitDelayMs(platform, agent)
  const maxLineSettle = Math.max(
    0,
    ...Object.values(TUI_AGENT_CONFIG).map((c) => c.submitLineSettleMsPerLine ?? 0)
  )
  const upperSchedule =
    16000 +
    getTerminalPasteIngestMs('win32', nativeBytes) +
    getAgentPromptSubmitDelayMs('win32', generatedBytes, {
      lineCount: lines,
      lineSettleMsPerLine: maxLineSettle
    })
  const executionMs = (schedule: number) => Math.max(30000, schedule + 5000)
  const lifetimeMs = 30000 + executionMs(upperSchedule) + 5000
  if (!isSafeTimerDelayMs(lifetimeMs)) {
    throw new Error('Invalid Chat input budget')
  }
  return { scheduleMs, executionMs, lifetimeMs, ingestMs, submitDelayMs }
}
