import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatGalleryProjectionCache } from './native-chat-gallery-projection-cache'
import { NativeChatGalleryProjectionLimitError } from './native-chat-gallery-projection-budget'
import { nativeChatGallerySlotSurfaces } from './native-chat-gallery-surfaces'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'

function read(input: unknown): NativeChatMessage {
  return {
    id: 'read',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'tool-call', name: 'Read', input, state: 'completed' }]
  }
}
function project(message: NativeChatMessage, workRun?: NativeChatMessage[]) {
  const options = { visuals: false, stoppedLabel: '' }
  return new NativeChatGalleryProjectionCache().prepare(
    { key: 'slot:read', message, workRun, active: false, trailing: false },
    options,
    () =>
      nativeChatGallerySlotSurfaces(
        {
          message,
          workRun,
          drawsMessage: true,
          receipt: false,
          activeTurnIsWorking: false,
          trailingRun: false
        },
        options
      )
  )
}

it('rejects oversized serialized tool input while retaining admissible decoded read semantics', () => {
  const unrelated = 'seed '.repeat(40_000)
  expect(() => project(read(JSON.stringify({ file_path: '/tmp/read.png', unrelated })))).toThrow(
    NativeChatGalleryProjectionLimitError
  )
  const admitted = project(read({ file_path: '/tmp/read.png', unrelated }))
  expect(
    admitted.surfaces.flatMap((surface) =>
      surface.kind === 'files' ? surface.blocks.map((block) => block.path) : []
    )
  ).toEqual(['/tmp/read.png'])
})

it.each(['summary', 'error', 'label'])(
  'rejects oversized task %s before cold display derivation',
  (field) => {
    const message: NativeChatMessage = {
      id: 'task',
      role: 'assistant',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        { type: 'text', text: '![image](/tmp/task.png)' },
        { type: 'text', text: 'stopped', presentation: 'stopped-before-start' },
        {
          type: 'background-task',
          taskId: 'task',
          kind: 'agent',
          state: 'done',
          label: 'Task',
          [field]: `${' '.repeat(70_000)}value`
        }
      ]
    }
    deriveNativeChatRowContent(message.blocks)
    expect(() => project(message)).toThrow(NativeChatGalleryProjectionLimitError)
  }
)

it('rejects a single oversized work run before projecting a partial image gallery', () => {
  const message = read({ file_path: '/tmp/read.png' })
  expect(() =>
    project(
      message,
      Array.from({ length: 513 }, () => message)
    )
  ).toThrow(NativeChatGalleryProjectionLimitError)
})
