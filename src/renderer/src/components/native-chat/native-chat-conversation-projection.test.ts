import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { createNativeChatConversationProjection } from './native-chat-conversation-projection'

function text(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

it('preserves task conversion and mode-dependent goal omission across revisions and structural changes', () => {
  const frame = (id: string, kind: string, head: string): NativeChatMessage => ({
    ...text(id),
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: 'provider notice',
        providerFrame: {
          provider: 'codex',
          kind,
          payload: { head, byteLength: head.length, digest: id, truncated: false }
        }
      }
    ]
  })
  const plan = frame(
    'plan',
    'notification:turn/plan/updated',
    '{"plan":[{"step":"Inspect","status":"completed"}]}'
  )
  const goal = frame('goal', 'notification:thread/goal/cleared', '{}')
  const invalid = frame('invalid', 'notification:turn/plan/updated', 'invalid json')
  const project = createNativeChatConversationProjection()
  expect(project([plan, goal, invalid], true).map((row) => row.id)).toEqual(['plan', 'invalid'])
  expect(project([plan], false)[0]?.blocks).toEqual([
    {
      type: 'tool-call',
      name: 'update_plan',
      input: '{"plan":[{"step":"Inspect","status":"completed"}]}',
      state: 'completed'
    }
  ])
  const changedRole = { ...goal, role: 'assistant' as const }
  const truncated = frame('truncated', 'notification:turn/plan/updated', '{"plan":[]}')
  if (truncated.blocks[0]?.type === 'text' && truncated.blocks[0].providerFrame) {
    truncated.blocks[0].providerFrame.payload.truncated = true
  }
  const planOutput = {
    id: 'plan',
    role: 'assistant',
    blocks: [
      {
        type: 'tool-call',
        name: 'update_plan',
        input: '{"plan":[{"step":"Inspect","status":"completed"}]}',
        state: 'completed'
      }
    ]
  }
  const goalOutput = {
    id: 'goal',
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: 'provider notice',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:thread/goal/cleared',
          payload: { head: '{}', byteLength: 2, digest: 'goal', truncated: false }
        }
      }
    ]
  }
  const invalidOutput = {
    id: 'invalid',
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: 'provider notice',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:turn/plan/updated',
          payload: { head: 'invalid json', byteLength: 12, digest: 'invalid', truncated: false }
        }
      }
    ]
  }
  const assistantGoalOutput = { ...goalOutput, role: 'assistant' }
  const truncatedOutput = {
    id: 'truncated',
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: 'provider notice',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:turn/plan/updated',
          payload: { head: '{"plan":[]}', byteLength: 11, digest: 'truncated', truncated: true }
        }
      }
    ]
  }
  for (const [rows, visible, hidden] of [
    [
      [plan, goal, invalid],
      [planOutput, goalOutput, invalidOutput],
      [planOutput, invalidOutput]
    ],
    [[goal, plan], [goalOutput, planOutput], [planOutput]],
    [
      [changedRole, invalid],
      [assistantGoalOutput, invalidOutput],
      [assistantGoalOutput, invalidOutput]
    ],
    [
      [truncated, plan, plan],
      [truncatedOutput, planOutput, planOutput],
      [truncatedOutput, planOutput, planOutput]
    ],
    [[], [], []]
  ] as const) {
    expect(project([...rows], false).map(({ id, role, blocks }) => ({ id, role, blocks }))).toEqual(
      visible
    )
    expect(project([...rows], true).map(({ id, role, blocks }) => ({ id, role, blocks }))).toEqual(
      hidden
    )
  }
})
