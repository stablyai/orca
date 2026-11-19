import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import { normalizeAgentStatusPayload } from './agent-status/contracts/agent-status-types'
import { BOT_CREATED_KICKOFF, BOT_CREATED_STATUS_LABEL } from './bot-created-kickoff'
import { latestStructuredAgentSessionPrompt } from './agent-session/requests/structured-agent-session-latest-request'

function kickoff(origin?: 'bot-created'): AgentJournalRenderItem {
  return {
    itemId: 'kickoff',
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: origin ? BOT_CREATED_KICKOFF : 'Review #42' }],
      ...(origin ? { origin } : {})
    },
    turnScope: { kind: 'thread' }
  }
}

describe("status for Orca's kickoff to a new bot", () => {
  it('names the kickoff turn neutrally in the journal status', () => {
    expect(latestStructuredAgentSessionPrompt([kickoff('bot-created')])).toBe(
      BOT_CREATED_STATUS_LABEL
    )
    expect(latestStructuredAgentSessionPrompt([kickoff()])).toBe('Review #42')
  })

  it('relabels the kickoff a hook reports as the prompt', () => {
    const status = (prompt: string) =>
      normalizeAgentStatusPayload({ state: 'working', prompt, agentType: 'claude' })?.prompt
    expect(status(`${BOT_CREATED_KICKOFF}\n`)).toBe(BOT_CREATED_STATUS_LABEL)
    expect(status('Review #42')).toBe('Review #42')
  })
})
