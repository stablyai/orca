import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'
import {
  nativeChatGalleryGroup,
  nativeChatGalleryRecords
} from './native-chat-image-gallery-records'
it('keeps four response images separate from seven tool previews in the same turn', () => {
  const messages: NativeChatMessage[] = [
    {
      id: 'user',
      role: 'user',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'image-ref', path: '/repo/input.png' }]
    },
    ...Array.from({ length: 7 }, (_, index): NativeChatMessage => ({
      id: `tool-preview-${index}`,
      role: 'assistant',
      timestamp: null,
      source: 'transcript',
      blocks: [
        { type: 'text', text: 'Viewed image' },
        { type: 'image-ref', path: `/repo/tool-${index}.png` }
      ]
    })),
    {
      id: 'response',
      role: 'assistant',
      timestamp: null,
      source: 'transcript',
      blocks: [
        {
          type: 'text',
          text: '![One](/repo/one.png)\n\n![Two](/repo/two.png)\n\n![Three](/repo/three.png)\n\n![Four](/repo/four.png)'
        }
      ]
    }
  ]
  const rows: NativeChatTurnRows = {
    messages,
    turnKeys: messages.map(() => 'same-turn'),
    liveTurnKey: undefined
  }
  expect(
    nativeChatGalleryRecords(rows, nativeChatGalleryGroup(rows, 8), false).map(
      (record) => record.source
    )
  ).toEqual(['/repo/one.png', '/repo/two.png', '/repo/three.png', '/repo/four.png'])
  expect(
    nativeChatGalleryRecords(rows, nativeChatGalleryGroup(rows, 1), false).map(
      (record) => record.source
    )
  ).toEqual(['/repo/tool-0.png'])
  expect(
    nativeChatGalleryRecords(rows, nativeChatGalleryGroup(rows, 0), false).map(
      (record) => record.source
    )
  ).toEqual(['/repo/input.png'])
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
    nativeChatGalleryRecords(offscreen, nativeChatGalleryGroup(offscreen, 0), false).map(
      (record) => record.source
    )
  ).toEqual(['/repo/one.png', '/repo/two.png'])
})
