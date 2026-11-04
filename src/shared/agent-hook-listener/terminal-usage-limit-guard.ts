import type { HookListenerState } from './listener-state'
import { readClaudeTerminalUsageLimit } from './claude-terminal-usage-limit'
import { readJsonlCursor } from '../codex-rollout-jsonl-cursor'
import { isCodexStatusTranscriptLine } from '../codex-status-transcript-line'
import { reconcileCodexTerminalUsageLimit } from '../codex-terminal-usage-limit'

export type TerminalUsageLimitCut = { sessionId: string; turnEndedAt: number }

/** A manual submission still belongs to the failed turn the person saw, until another turn replaces it. */
export function terminalUsageLimitGuard(
  state: HookListenerState,
  paneKey: string,
  expected: TerminalUsageLimitCut
): (() => boolean) | null {
  const original = state.lastStatusByPaneKey.get(paneKey)
  const matches = (row: typeof original): row is NonNullable<typeof original> =>
    row !== undefined &&
    row.connectionId === null &&
    row.toolAgentId === undefined &&
    row.providerSessionOnly !== true &&
    row.agentPresence?.ended !== true &&
    row.structuredHost === undefined &&
    row.restoredUnconfirmed !== true &&
    row.providerSession?.id === expected.sessionId &&
    row.turnEndedAt === expected.turnEndedAt &&
    row.payload.mainAgent?.state === 'done' &&
    row.payload.mainAgent.outcome === 'failure' &&
    row.payload.mainAgent.usageLimit !== undefined
  if (!matches(original)) {
    return null
  }
  return () => {
    const current = state.lastStatusByPaneKey.get(paneKey)
    if (
      !matches(current) ||
      current.launchToken !== original.launchToken ||
      current.agentPresence?.process?.pid !== original.agentPresence?.process?.pid ||
      current.agentPresence?.process?.startTime !== original.agentPresence?.process?.startTime ||
      current.hostTurn?.owner !== original.hostTurn?.owner ||
      current.hostTurn?.currentTurnKey !== original.hostTurn?.currentTurnKey
    ) {
      return false
    }
    const path = current.providerSession?.transcriptPath
    if (current.payload.agentType === 'claude') {
      return Boolean(
        path &&
        current.providerPromptId &&
        readClaudeTerminalUsageLimit(path, {
          sessionId: expected.sessionId,
          promptId: current.providerPromptId
        })
      )
    }
    if (current.payload.agentType !== 'codex') {
      return false
    }
    const transcript = state.codexSubagentTranscriptByPaneKey.get(paneKey)
    if (!transcript?.usageLimitTurn.turnId) {
      return false
    }
    const cursor = { ...transcript.parent }
    let discontinuous = false
    const records = readJsonlCursor(cursor, isCodexStatusTranscriptLine, () => {
      discontinuous = true
    })
    if (!records || discontinuous || cursor.carry) {
      return false
    }
    const turn = { ...transcript.usageLimitTurn }
    reconcileCodexTerminalUsageLimit(turn, records)
    return turn.turnId === transcript.usageLimitTurn.turnId && turn.usageLimit !== undefined
  }
}
