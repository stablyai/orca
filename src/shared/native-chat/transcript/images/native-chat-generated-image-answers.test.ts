import { expect, it } from 'vitest'
import { generatedImageBlocks } from '../../native-chat-generated-image'
import type { NativeChatMessage } from '../../native-chat-types'
import { nativeChatGeneratedImageAnswers } from './native-chat-generated-image-answers'

function text(
  id: string,
  value: string,
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: value }], timestamp: 1, source: 'transcript' }
}
function generated(id: string, path = '/tmp/elephant.png'): NativeChatMessage {
  return {
    ...text(id, 'Generated image'),
    blocks: generatedImageBlocks([
      { type: 'text', text: 'Generated image' },
      { type: 'image-ref', path }
    ])
  }
}

it('deduplicates Windows and UNC destinations already rendered by Markdown, preserving raw output paths', () => {
  const messages = [
    generated('a', 'C:\\Users\\person\\elephant.png'),
    generated('b', '\\\\server\\share\\elephant.png'),
    generated('c', '/tmp/second.png'),
    generated('d', '/tmp/second.png'),
    text('answer', 'Pictures.')
  ]
  const rows = nativeChatGeneratedImageAnswers(
    messages,
    ['u', 'u', 'u', 'u', 'u'],
    new Set(['u']),
    () => ['file:///c:/Users/person/elephant.png', 'file://server/share/elephant.png']
  )
  expect(rows[4]!.blocks).toEqual([
    { type: 'text', text: 'Pictures.' },
    { type: 'image-ref', path: '/tmp/second.png' }
  ])
  expect(
    rows.slice(0, 4).flatMap((row) => row.blocks.filter((block) => block.type === 'image-ref'))
  ).toEqual([])
})
