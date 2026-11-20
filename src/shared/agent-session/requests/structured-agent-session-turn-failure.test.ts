import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../failures/agent-session-failure-words'
import { structuredAgentSessionTurnFailureLine } from './structured-agent-session-turn-failure'

const providerFrame = {
  provider: 'claude',
  kind: 'message:result:success',
  payload: { head: '', digest: '', byteLength: 0, truncated: false }
}

function row(
  body: AgentJournalRenderItem['body'],
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: `row-${Math.random()}`,
    revision: 1,
    sequence: 3,
    observedAt: 3,
    turnScope: { kind: 'turn', turnItemId: 'run-turn' },
    body,
    ...overrides
  }
}

describe('structuredAgentSessionTurnFailureLine', () => {
  it("keeps the provider's own error from the turn's root row", () => {
    const items = [
      row({
        kind: 'status',
        tone: 'error',
        text: 'API Error: 503 All accounts are temporarily unavailable.',
        providerFrame
      })
    ]
    expect(structuredAgentSessionTurnFailureLine(items, 'run-turn')).toBe(
      'API Error: 503 All accounts are temporarily unavailable.'
    )
    expect(structuredAgentSessionTurnFailureLine(items, 'other-turn')).toBeUndefined()
  })

  it('words a typed failure and skips child rows, retry progress and unattributed errors', () => {
    const limit = row({
      kind: 'status',
      ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
    })
    const ignored = [
      row(
        { kind: 'status', tone: 'error', text: 'child failed', providerFrame },
        { agentId: 'child' }
      ),
      row({
        kind: 'status',
        ...agentSessionFailureWords({ kind: 'providerRetrying' }, { surface: 'row' })
      }),
      row({ kind: 'status', tone: 'error', text: 'Error without a provider frame' })
    ]
    expect(structuredAgentSessionTurnFailureLine([limit, ...ignored], 'run-turn')).toBe(
      'The agent hit its usage limit.'
    )
    expect(structuredAgentSessionTurnFailureLine(ignored, 'run-turn')).toBeUndefined()
  })

  it('redacts secrets and keeps only the first line', () => {
    const items = [
      row({
        kind: 'status',
        tone: 'error',
        text: 'API error: api_key=private-value\n    at /private/source.ts:42',
        providerFrame
      })
    ]
    expect(structuredAgentSessionTurnFailureLine(items, 'run-turn')).toBe(
      'API error: api_key=[redacted]'
    )
  })
})
