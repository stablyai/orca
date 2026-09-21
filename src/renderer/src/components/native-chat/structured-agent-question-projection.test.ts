import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import {
  projectStructuredQuestionMessages,
  structuredQuestionTranscript
} from './structured-agent-question-projection'

function projectQuestion(item: AgentJournalRenderItem) {
  return projectStructuredQuestionMessages([item])[0]
}

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

function item(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return { itemId, sequence: 1, revision: 1, observedAt: 1, body }
}

describe('structured agent session ask-row projection', () => {
  it('gives a pending question a row instead of dropping it from the transcript', () => {
    // Codex only ever journals the question, so without this the reader sees
    // nothing in the log while the agent is blocked on them.
    const projected = projectQuestion(
      item('q', {
        kind: 'question',
        question: 'Which branch?',
        options: [{ id: 'q1:main', label: 'main' }],
        resolution: { ...PENDING }
      })
    )

    expect(projected?.role).toBe('system')
    expect(projected?.blocks).toEqual([{ type: 'text', text: 'Which branch?' }])
  })

  it('prefers a grouped prompt own questions over the label naming their count', () => {
    const grouped = item('grouped', {
      kind: 'question',
      question: '2 grouped questions from Claude',
      options: [],
      questions: [
        { id: 'q1', question: 'Which targets?', multiSelect: true, options: [] },
        { id: 'q2', question: 'Proceed?', multiSelect: false, options: [] }
      ],
      resolution: { ...PENDING }
    })
    expect(structuredQuestionTranscript([grouped]).receipts.get('grouped')).toBe(grouped.body)
  })

  it('suppresses only a matching question tool and preserves failed or unmatched calls', () => {
    const call = item('ask', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?' }] },
      state: 'running'
    })
    const question = item('q', {
      kind: 'question',
      question: 'Which branch?',
      options: [],
      resolution: { ...PENDING }
    })
    const turn = item('turn', { kind: 'turn', turnId: 'turn', state: 'running' })
    expect(projectStructuredQuestionMessages([call])).toHaveLength(1)
    expect(projectStructuredQuestionMessages([turn, call, question]).map((row) => row.id)).toEqual([
      'q'
    ])
    expect(projectStructuredQuestionMessages([call, question])).toHaveLength(2)
    const failed = item('failed', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: call.body.kind === 'tool-call' ? call.body.input : null,
      state: 'failed',
      output: { head: 'Denied', byteLength: 6, truncated: false, digest: 'a' }
    })
    expect(
      projectStructuredQuestionMessages([turn, failed, question]).map((row) => row.id)
    ).toEqual(['failed', 'q'])
    const user = item('user', {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Next turn' }]
    })
    expect(projectStructuredQuestionMessages([call, user, question])).toHaveLength(3)
    const nextTurn = item('next-turn', { kind: 'turn', turnId: 'next-turn', state: 'running' })
    expect(projectStructuredQuestionMessages([turn, call, nextTurn, question])).toHaveLength(2)
  })

  it('suppresses only as many duplicate calls as question items', () => {
    const turn = item('turn', { kind: 'turn', turnId: 'turn', state: 'running' })
    const firstCall = item('ask-1', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?' }] },
      state: 'running'
    })
    const secondCall = item('ask-2', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?' }] },
      state: 'running'
    })
    const question = item('q', {
      kind: 'question',
      question: 'Which branch?',
      options: [],
      resolution: { ...PENDING }
    })

    expect(projectStructuredQuestionMessages([turn, firstCall, secondCall, question])).toEqual([
      expect.objectContaining({ id: 'ask-2' }),
      expect.objectContaining({ id: 'q' })
    ])
  })

  it('folds a settled matching tool call into its resolved question receipt', () => {
    const turn = item('turn', { kind: 'turn', turnId: 'turn', state: 'completed' })
    const firstCall = item('ask-1', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?' }] },
      state: 'completed',
      output: { head: 'main', byteLength: 4, truncated: false, digest: 'a' }
    })
    const secondCall = item('ask-2', {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which branch?' }] },
      state: 'completed',
      output: { head: 'main', byteLength: 4, truncated: false, digest: 'b' }
    })
    const question = item('q', {
      kind: 'question',
      question: 'Which branch?',
      options: [{ id: 'main', label: 'main' }],
      resolution: { ...PENDING, state: 'resolved', selectedOptionId: 'main' }
    })

    expect(
      projectStructuredQuestionMessages([turn, firstCall, secondCall, question]).map(
        (row) => row.id
      )
    ).toEqual(['ask-2', 'q'])
  })

  it('counts adjacent pending questions and preserves each independently settled answer', () => {
    const first = item('q1', {
      kind: 'question',
      question: 'Branch?',
      options: [],
      resolution: { ...PENDING }
    })
    const second = item('q2', {
      kind: 'question',
      question: 'Proceed?',
      options: [],
      resolution: { ...PENDING }
    })
    const pending = structuredQuestionTranscript([first, second])
    const unrelated = item('status', { kind: 'status', text: 'Background work' })
    const refreshed = structuredQuestionTranscript([first, second, unrelated])
    expect(refreshed.messages[0]).toBe(pending.messages[0])
    expect(refreshed.receipts.get('q1')).toBe(pending.receipts.get('q1'))
    expect(pending.messages.map((row) => row.id)).toEqual(['q1'])
    expect(pending.receipts.get('q1')).toMatchObject({
      questions: [{ question: 'Branch?' }, { question: 'Proceed?' }]
    })
    const resolved = item('q1', {
      kind: 'question',
      question: 'Branch?',
      options: [{ id: 'main', label: 'main' }],
      resolution: { ...PENDING, state: 'resolved', selectedOptionId: 'main' }
    })
    const partial = structuredQuestionTranscript([resolved, second])
    expect(partial.messages.map((row) => row.id)).toEqual(['q1', 'q2'])
    expect(partial.receipts.get('q1')).toBe(resolved.body)
    expect(partial.receipts.get('q2')).toBe(second.body)
  })

  it('keeps host projection unchanged and question revisions authoritative', () => {
    const pending = item('q', {
      kind: 'question',
      question: 'Proceed?',
      options: [],
      resolution: { ...PENDING }
    })
    expect(projectStructuredItemToNativeChat(pending)).toBeNull()
    const initial = projectStructuredQuestionMessages([pending])[0]
    expect(projectStructuredQuestionMessages([pending])[0]).toBe(initial)
    const resolved = item('q', {
      kind: 'question',
      question: 'Proceed?',
      options: [],
      resolution: { ...PENDING, state: 'resolved' }
    })
    expect(projectStructuredQuestionMessages([resolved])[0]).toMatchObject({ role: 'system' })
    expect(projectStructuredQuestionMessages([resolved])[0]).not.toBe(initial)
  })

  it('keeps an ordinary tool call', () => {
    expect(
      projectStructuredItemToNativeChat(
        item('read', {
          kind: 'tool-call',
          name: 'Read',
          input: { file_path: 'a.ts' },
          state: 'running'
        })
      )?.blocks
    ).toHaveLength(1)
  })
})
