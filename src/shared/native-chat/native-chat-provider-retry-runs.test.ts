import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../agent-session/journal/agent-session-journal-item-key'
import { projectNativeChatTranscript } from './transcript/native-chat-transcript-projection'
import type { NativeChatMessage } from './native-chat-types'
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

function texts(messages: readonly NativeChatMessage[]): string[] {
  return messages.map((message) =>
    message.blocks.map((block) => (block.type === 'text' ? block.text : block.type)).join('')
  )
}

function drawn(items: AgentJournalRenderItem[]): string[] {
  return texts(projectStructuredAgentSessionMessages(items, [], []))
}

describe('a run of provider retry rows', () => {
  it("is split by any other of the same agent's rows drawn between two retries", () => {
    const notice = item({ kind: 'status', tone: 'notice', text: 'Model changed' })
    expect(
      drawn([retry(1), retry(2), assistant('Partial answer'), retry(1), notice, retry(1)])
    ).toEqual([
      'Codex is retrying: Reconnecting... 2/5.',
      'Partial answer',
      'Codex is retrying: Reconnecting... 1/5.',
      'Model changed',
      'Codex is retrying: Reconnecting... 1/5.'
    ])
  })

  it('draws one row per agent when agents retrying at once interleave', () => {
    expect(
      drawn([retry(1), retry(1, 'subagent-1'), retry(2), retry(2, 'subagent-1'), retry(3)])
    ).toEqual([
      'Codex is retrying: Reconnecting... 2/5.',
      'Codex is retrying: Reconnecting... 3/5.'
    ])
  })

  it("is not split by another agent's row, which is drawn in that agent's own section", () => {
    const { conversation, subagentRows } = projectNativeChatTranscript(
      projectStructuredAgentSessionMessages(
        [
          retry(1),
          assistant('Subagent ran the tests', 'subagent-1'),
          retry(2),
          retry(1, 'subagent-1'),
          assistant('Still working'),
          retry(2, 'subagent-1')
        ],
        [],
        []
      )
    )
    expect(texts(conversation)).toEqual([
      'Codex is retrying: Reconnecting... 2/5.',
      'Still working'
    ])
    expect(texts((subagentRows.get('subagent-1') ?? []).map((row) => row.message))).toEqual([
      'Subagent ran the tests',
      'Codex is retrying: Reconnecting... 2/5.'
    ])
  })

  it('is not split by a row that draws nothing', () => {
    const turn = item({ kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 })
    expect(drawn([retry(1), turn, retry(2)])).toEqual(['Codex is retrying: Reconnecting... 2/5.'])
  })

  it('is not split by a queued send, which is drawn after the conversation', () => {
    const queued = item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Next' }] })
    const messages = projectStructuredAgentSessionMessages(
      [retry(1), { ...queued, itemId: agentJournalSubmissionKey('queued-1') }, retry(2)],
      [],
      [
        {
          clientMessageId: 'queued-1',
          fence: 1,
          payloadFingerprint: 'queued-1',
          dispatchState: 'pending',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null,
          handoverRecorded: true
        }
      ]
    )
    expect(messages.map((message) => [message.id, message.queued ?? false])).toEqual([
      [expect.stringMatching(/^item-/), false],
      [agentJournalSubmissionKey('queued-1'), true]
    ])
  })
})

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
