import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../agent-session/failures/agent-session-failure-words'
import { projectStructuredAgentSessionMessages } from '../agent-session/view/structured-agent-session-message-projection'

let sequence = 0

function item(body: AgentJournalRenderItem['body'], agentId?: string): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence,
    body,
    ...(agentId ? { agentId } : {})
  }
}

function retry(attempt: number, agentId?: string): AgentJournalRenderItem {
  return item(
    {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        {
          kind: 'providerRetrying',
          detail: { text: `Reconnecting... ${attempt}/5`, audience: 'person' }
        },
        { surface: 'row', agentName: 'Codex' }
      )
    },
    agentId
  )
}

function assistant(text: string, agentId?: string): AgentJournalRenderItem {
  return item({ kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }, agentId)
}

describe("a drawn retry row's run", () => {
  const named = (itemId: string, row: AgentJournalRenderItem): AgentJournalRenderItem => ({
    ...row,
    itemId
  })
  const lead = named('lead', assistant('Working'))
  const [r1, r2, r3, r4] = ['r1', 'r2', 'r3', 'r4'].map((id, index) => named(id, retry(index + 1)))
  const runs = (items: AgentJournalRenderItem[]) =>
    projectStructuredAgentSessionMessages(items, [], [])
      .filter((message) => message.role === 'system')
      .map((message) => [message.id, message.providerRetryRunIds])

  it('lists the loaded retries it replaced, oldest first, wherever loaded history starts', () => {
    expect(runs([lead, r2, r3])).toEqual([['r3', ['r2', 'r3']]])
    expect(runs([lead, r1, r2, r3])).toEqual([['r3', ['r1', 'r2', 'r3']]])
    expect(runs([r3, r4])).toEqual([['r4', ['r3', 'r4']]])
    expect(runs([r4])).toEqual([['r4', undefined]])
  })

  it('never shares a retry between two runs or two agents', () => {
    const worker = [named('w1', retry(1, 'worker')), named('w2', retry(2, 'worker'))]
    expect(runs([r1, r2, named('reply', assistant('Partial answer')), r3, r4])).toEqual([
      ['r2', ['r1', 'r2']],
      ['r4', ['r3', 'r4']]
    ])
    expect(runs([r1, worker[0]!, r2, worker[1]!])).toEqual([
      ['r2', ['r1', 'r2']],
      ['w2', ['w1', 'w2']]
    ])
  })
})
