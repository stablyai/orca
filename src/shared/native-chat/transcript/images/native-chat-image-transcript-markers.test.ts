import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { normalizeImageTranscriptMessages } from './native-chat-image-transcript-markers'

function userRow(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1_000,
    source: 'transcript'
  }
}

it('folds the image-source row Claude writes after its prompt into that prompt', () => {
  const rows: NativeChatMessage[] = [
    userRow('prompt', '[Image #1] why does the upload fail?'),
    userRow('source', '[Image: source: /mnt/c/Temp/orca-paste-1.jpg]'),
    { ...userRow('reply', 'Looking.'), role: 'assistant' }
  ]

  expect(normalizeImageTranscriptMessages(rows).map((row) => [row.id, row.blocks])).toEqual([
    [
      'prompt',
      [
        { type: 'image-ref', path: '/mnt/c/Temp/orca-paste-1.jpg' },
        { type: 'text', text: 'why does the upload fail?' }
      ]
    ],
    ['reply', [{ type: 'text', text: 'Looking.' }]]
  ])
})
