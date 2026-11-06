import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { projectNativeChatTaskListFrames } from '../../../../shared/native-chat/input/native-chat-task-list-frames'
import { omitNativeChatThreadGoalRows } from '../../../../shared/native-chat/transcript/native-chat-thread-goal-rows'
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

it.each([100, 1000])(
  'does not inspect unchanged rows during final projection at %i rows',
  (size) => {
    let reads = 0
    const rows = Array.from({ length: size }, (_, index) => {
      const message = text(`row-${index}`)
      message.role = index % 2 ? 'system' : 'assistant'
      if (message.role === 'system') {
        message.blocks = [
          {
            type: 'text',
            text: 'notice',
            providerFrame: {
              provider: 'codex',
              kind:
                index % 4 === 1
                  ? 'notification:turn/plan/updated'
                  : 'notification:thread/goal/cleared',
              payload: {
                head: 'invalid json',
                byteLength: 12,
                digest: message.id,
                truncated: false
              }
            }
          }
        ]
      }
      const blocks = message.blocks
      Object.defineProperty(message, 'blocks', {
        get: () => {
          reads++
          return blocks
        }
      })
      return message
    })
    const project = createNativeChatConversationProjection()
    project(rows, true)
    reads = 0
    const updated = project(
      [...rows.slice(0, -1), { ...text('changed'), role: 'system' as const }],
      true
    )
    expect(reads).toBe(0)
    expect(updated.at(-1)?.blocks).toEqual([{ type: 'text', text: 'changed' }])
    expect(updated[0]).toBe(rows[0])
  }
)

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
  for (const rows of [
    [plan, goal, invalid],
    [goal, plan],
    [changedRole, invalid],
    [truncated, plan, plan],
    []
  ]) {
    for (const hideGoals of [false, true]) {
      const full = projectNativeChatTaskListFrames(rows)
      expect(project(rows, hideGoals)).toEqual(
        hideGoals ? omitNativeChatThreadGoalRows(full) : full
      )
    }
  }
})
