import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'
import { nativeChatGalleryRecords } from './native-chat-image-gallery-records'
const messages: NativeChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'image-ref', path: '/repo/input.png' }]
  },
  {
    id: 'a1',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'image-ref', path: '/repo/first.png' }]
  },
  {
    id: 'a2',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'image-ref', path: '/repo/second.png' }]
  },
  {
    id: 'u2',
    role: 'user',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Next request' }]
  },
  {
    id: 'a3',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [{ type: 'image-ref', path: '/repo/other-turn.png' }]
  }
]
const rows: NativeChatTurnRows = {
  messages,
  turnKeys: ['turn-1', 'turn-1', 'turn-1', 'turn-2', 'turn-2'],
  liveTurnKey: 'turn-2'
}
it('groups a response in source order and separates its user images and the next response', () => {
  expect(nativeChatGalleryRecords(rows, 'turn-1', false).map((record) => record.source)).toEqual([
    '/repo/first.png',
    '/repo/second.png'
  ])
  expect(nativeChatGalleryRecords(rows, 'user:u1', false).map((record) => record.source)).toEqual([
    '/repo/input.png'
  ])
})
it('discovers reference-style markdown images in rows that have no mounted image component', () => {
  const row: NativeChatMessage = {
    id: 'markdown',
    role: 'assistant',
    timestamp: null,
    source: 'transcript',
    blocks: [
      { type: 'text', text: '![First][one]\n\n![Second](/repo/two.png)\n\n[one]: /repo/one.png' }
    ]
  }
  const offscreen: NativeChatTurnRows = {
    messages: [row],
    turnKeys: ['turn-3'],
    liveTurnKey: undefined
  }
  expect(
    nativeChatGalleryRecords(offscreen, 'turn-3', false).map((record) => record.source)
  ).toEqual(['/repo/one.png', '/repo/two.png'])
})
