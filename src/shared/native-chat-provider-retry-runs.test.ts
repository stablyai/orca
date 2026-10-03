import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import { collapseProviderRetryRuns } from './native-chat-provider-retry-runs'
import { projectNativeChatTranscript } from './native-chat-transcript-projection'
import type { NativeChatMessage } from './native-chat-types'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

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
  it('draws only its latest row', () => {
    expect(drawn([assistant('Working'), retry(1), retry(2), retry(3)])).toEqual([
      'Working',
      'Codex is retrying: Reconnecting... 3/5.'
    ])
  })

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

  it("keeps each agent's retries apart", () => {
    expect(drawn([retry(1), retry(1, 'subagent-1'), retry(2, 'subagent-1')])).toEqual([
      'Codex is retrying: Reconnecting... 1/5.',
      'Codex is retrying: Reconnecting... 2/5.'
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

  it("draws an older host's single revised row as it is", () => {
    expect(drawn([retry(4)])).toEqual(['Codex is retrying: Reconnecting... 4/5.'])
  })

  it('hands back the same list when nothing retried', () => {
    const messages: NativeChatMessage[] = [
      { id: 'a', role: 'assistant', blocks: [], timestamp: 1, source: 'transcript' }
    ]
    expect(collapseProviderRetryRuns(messages)).toBe(messages)
  })
})
