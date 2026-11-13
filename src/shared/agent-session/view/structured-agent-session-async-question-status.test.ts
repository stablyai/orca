import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../journal/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from './structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence * 100, body }
}

const user = item('user', 1, {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Start' }]
})
const running = item('turn', 2, { kind: 'turn', turnId: 't1', state: 'running', startedAt: 200 })
const question = (id: string, sequence: number, titles: string[]) =>
  item(id, sequence, {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        callId: id,
        input: { questions: titles.map((title) => ({ title, options: ['Yes', 'No'] })) }
      }
    ]
  })
const answer = (text: string) =>
  item('answer', 6, { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] })

describe('async question attention', () => {
  const first = question('first', 3, ['Database?', 'Region?'])
  const second = question('second', 4, ['Deploy?'])

  it('retains attention and execution separately through output, turn completion and replay', () => {
    const output = item('output', 5, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Still working' }]
    })
    const followUp = item('follow-up', 6, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Continue the independent work' }]
    })
    const rows = [user, running, first, second, output, followUp]
    expect(projectStructuredAgentSessionStatusState(rows)).toMatchObject({
      summary: { status: 'attention', statusStartedAt: 300 },
      owesWork: true,
      pendingPromptIds: ['first', 'second']
    })
    const completed = {
      ...running,
      body: { kind: 'turn', turnId: 't1', state: 'completed', completedAt: 700 }
    } as const
    expect(
      projectStructuredAgentSessionStatusState(
        JSON.parse(JSON.stringify([user, completed, first, second, output, followUp]))
      )
    ).toMatchObject({
      summary: { status: 'attention', statusStartedAt: 300 },
      owesWork: false,
      pendingPromptIds: ['first', 'second']
    })
  })

  it('clears only answered questions, keeping siblings and other calls pending', () => {
    const rows = [user, running, first, second, answer('> Database?\n\nYes')]
    expect(projectStructuredAgentSessionStatusState(rows)).toMatchObject({
      summary: { status: 'attention' },
      owesWork: true,
      pendingPromptIds: ['first', 'second']
    })
    rows.push(
      item('answer-region', 7, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '> Region?\n\nNo' }]
      })
    )
    expect(projectStructuredAgentSessionStatusState(rows)).toMatchObject({
      summary: { status: 'attention', statusStartedAt: 400 },
      pendingPromptIds: ['second']
    })
    rows.push(
      item('answer-deploy', 8, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '> Deploy?\n\nYes' }]
      })
    )
    expect(projectStructuredAgentSessionStatusState(rows)).toMatchObject({
      summary: { status: 'working' },
      owesWork: true,
      pendingPromptIds: []
    })
  })

  it('uses addressed reply identities when different calls repeat the same question', () => {
    const rows = [user, running, question('a', 3, ['Same?', 'Same?']), question('b', 4, ['Same?'])]
    const reply = (id: string, index: number) =>
      `<send_user_message_question_reply>${JSON.stringify([
        { questionItemId: JSON.stringify(['request_user_input_async', id, index]), answer: 'Yes' }
      ])}</send_user_message_question_reply>`
    rows.push({ ...question('a', 5, ['Same?', 'Same?']), itemId: 'duplicate-a' })
    rows.push(item('next-turn', 5, { kind: 'turn', turnId: 't2', state: 'running' }))
    rows.push(answer(reply('a', 0)))
    expect(projectStructuredAgentSessionStatusState(rows).pendingPromptIds).toEqual(['a', 'b'])
    rows.push(
      item('answer-2', 7, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: reply('a', 1) }]
      })
    )
    expect(projectStructuredAgentSessionStatusState(rows).pendingPromptIds).toEqual(['b'])
  })

  it('does not treat an undelivered answer or an agent notice as human input', () => {
    const pending = answer('> Database?\n\nYes\n\n> Region?\n\nYes')
    pending.itemId = 'orca:reply'
    const notice = item('notice', 7, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Automated update' }],
      from: { kind: 'agent', senders: [], orchestration: null }
    })
    expect(
      projectStructuredAgentSessionStatusState(
        [user, running, first, pending, notice],
        [
          {
            clientMessageId: 'reply',
            fence: 1,
            payloadFingerprint: 'reply',
            dispatchState: 'pending',
            providerItemId: null,
            reason: null,
            submittedAt: 600,
            resolvedAt: null,
            queuedMessageId: 'queued-answer'
          }
        ]
      )
    ).toMatchObject({ summary: { status: 'attention' }, pendingPromptIds: ['first'] })
  })

  it('drops cancelled questions on interruption and excludes ended generations', () => {
    expect(
      projectStructuredAgentSessionStatusState([user, running, first]).pendingPromptIds
    ).toEqual(['first'])
    const interrupted = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'interrupted',
      completedAt: 500
    })
    expect(projectStructuredAgentSessionStatusState([user, interrupted, first])).toMatchObject({
      summary: { status: 'idle' },
      pendingPromptIds: []
    })
    expect(
      projectStructuredAgentSessionStatusState([user, running, first], [], 2, {
        isCurrentItem: (id) => id === 'turn',
        owesSend: () => false
      })
    ).toMatchObject({ summary: { status: 'working' }, pendingPromptIds: [] })
    expect(
      projectStructuredAgentSessionStatusState(
        [user, running, first, { ...first, itemId: 'current-question', sequence: 4 }],
        [],
        2,
        {
          isCurrentItem: (id) => id === 'turn' || id === 'current-question',
          owesSend: () => false
        }
      )
    ).toMatchObject({ summary: { status: 'attention' }, pendingPromptIds: ['current-question'] })
  })
})
