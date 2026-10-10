import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalThreadGoal
} from './agent-session-journal-types'
import {
  agentSessionCurrentContextRows,
  isAgentSessionContextClear,
  isNativeChatContextClear,
  latestAgentSessionContextClearSequence
} from './agent-session-context-clear'
import {
  currentAgentSessionThreadGoal,
  currentAgentSessionThreadGoalBySequence
} from './agent-session-thread-goal'
import {
  activeStructuredAgentSessionTurnId,
  newestStructuredAgentSessionTurn
} from './structured-agent-session-live-turn'
import {
  projectStructuredAgentSessionStatusState,
  projectStructuredItemToNativeChat
} from './structured-agent-session-projection'
import {
  latestStructuredAgentContextFacts,
  selectStructuredAgentContextUsage
} from './structured-agent-session-context-usage'
import { owesStructuredAgentSessionWork } from './structured-agent-session-owed-work'

const boundary = { operationId: 'clear', afterFence: 3, clearedAt: 100 }
const row = (sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem => ({
  itemId: `row-${sequence}`,
  sequence,
  revision: 1,
  observedAt: sequence,
  body
})
const clear = row(5, {
  kind: 'status',
  text: 'Localized fallback',
  presentation: 'context-cleared',
  contextClear: boundary
})
const oldSend: AgentJournalSubmission = {
  clientMessageId: 'old-send',
  fence: 3,
  payloadFingerprint: 'same',
  dispatchState: 'unknown',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null,
  acceptedSequence: 2
}
const user = row(1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Prior prompt' }]
})
const running = row(3, { kind: 'turn', turnId: 'old-turn', state: 'running' })
const oldPrompt = row(4, {
  kind: 'question',
  question: 'Old question',
  options: [],
  resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
})
const goal: AgentJournalThreadGoal = {
  objective: 'Old goal',
  status: 'active',
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1,
  updatedAt: 1
}
const goalRow = row(2, { kind: 'status', text: 'Goal set', threadGoal: { state: 'set', goal } })
const usageRow = row(3, {
  kind: 'turn',
  turnId: 'old-turn',
  state: 'completed',
  contextUsage: {
    window: { tokens: 200_000, capturedAt: 1 },
    used: {
      kind: 'estimate',
      capturedAt: 1,
      usage: {
        inputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0
      }
    }
  }
})

describe('completed context clear projections', () => {
  it('uses typed metadata and carries it through the shared desktop and mobile row', () => {
    expect(isAgentSessionContextClear(clear.body)).toBe(true)
    expect(
      isAgentSessionContextClear({
        kind: 'status',
        text: 'Context cleared',
        presentation: 'context-cleared'
      })
    ).toBe(false)
    const message = projectStructuredItemToNativeChat(clear)!
    expect(message).toMatchObject({
      role: 'system',
      blocks: [{ text: 'Localized fallback', contextClear: boundary }]
    })
    expect(isNativeChatContextClear(message)).toBe(true)
  })

  it('leaves earlier rows and uncertainty visible while clearing current work and prompts', () => {
    const rows = [user, running, oldPrompt, clear]
    const state = projectStructuredAgentSessionStatusState(rows, [oldSend], 3)
    expect(state.summary).toEqual({ status: 'idle', latestPrompt: 'Prior prompt' })
    expect(state.latestRequest).toBeNull()
    expect(state.pendingPromptIds).toEqual([])
    expect(state.owesWork).toBe(false)
    expect(owesStructuredAgentSessionWork(rows, [oldSend], 3)).toBe(false)
    expect(activeStructuredAgentSessionTurnId(rows)).toBeNull()
    expect(newestStructuredAgentSessionTurn(rows)).toBeNull()
    expect(rows).toHaveLength(4)
    expect(oldSend.dispatchState).toBe('unknown')
  })

  it('includes new sends but excludes older unknown sends even at the current fence', () => {
    const currentSend = { ...oldSend, clientMessageId: 'new-send', acceptedSequence: 6 }
    const rows = [user, clear, row(7, { kind: 'turn', turnId: 'new-turn', state: 'running' })]
    expect(agentSessionCurrentContextRows(rows, [oldSend, currentSend])).toEqual({
      items: [rows[2]],
      submissions: [currentSend]
    })
    expect(activeStructuredAgentSessionTurnId(rows)).toBe('new-turn')
    expect(owesStructuredAgentSessionWork(rows, [oldSend, currentSend], 3)).toBe(true)
  })

  it('resets the current goal in sorted snapshots and unordered host maps', () => {
    expect(currentAgentSessionThreadGoal([goalRow, clear])).toBeNull()
    expect(currentAgentSessionThreadGoalBySequence([clear, goalRow])).toBeNull()
    const newGoal = row(6, {
      kind: 'status',
      text: 'Goal set',
      threadGoal: { state: 'set', goal: { ...goal, objective: 'New goal' } }
    })
    expect(currentAgentSessionThreadGoalBySequence([newGoal, goalRow, clear])?.objective).toBe(
      'New goal'
    )
    expect(currentAgentSessionThreadGoal([goalRow], clear.sequence)).toBeUndefined()
  })

  it('does not use earlier usage or stale whole-journal facts after a loaded clear', () => {
    const old = latestStructuredAgentContextFacts([usageRow])
    expect(selectStructuredAgentContextUsage([usageRow, clear], old)).toBeNull()
    expect(latestStructuredAgentContextFacts([clear, usageRow])).toEqual({})
    const newUsage = { ...usageRow, itemId: 'new-usage', sequence: 6 }
    expect(latestStructuredAgentContextFacts([newUsage, clear, usageRow])).toEqual(old)
    expect(selectStructuredAgentContextUsage([usageRow], undefined, clear.sequence)).toBeNull()
  })

  it('chooses the newest clear independent of map order and scopes off-page rows', () => {
    const again = { ...clear, itemId: 'clear-again', sequence: 8 }
    expect(latestAgentSessionContextClearSequence([again, user, clear])).toBe(8)
    expect(agentSessionCurrentContextRows([user], [oldSend], 5)).toEqual({
      items: [],
      submissions: []
    })
  })
})
