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
  for (const [rows, visibleIds, hiddenIds] of [
    [
      [plan, goal, invalid],
      ['plan', 'goal', 'invalid'],
      ['plan', 'invalid']
    ],
    [[goal, plan], ['goal', 'plan'], ['plan']],
    [
      [changedRole, invalid],
      ['goal', 'invalid'],
      ['goal', 'invalid']
    ],
    [
      [truncated, plan, plan],
      ['truncated', 'plan', 'plan'],
      ['truncated', 'plan', 'plan']
    ],
    [[], [], []]
  ] as const) {
    expect(project([...rows], false).map((row) => row.id)).toEqual(visibleIds)
    expect(project([...rows], true).map((row) => row.id)).toEqual(hiddenIds)
  }
})
