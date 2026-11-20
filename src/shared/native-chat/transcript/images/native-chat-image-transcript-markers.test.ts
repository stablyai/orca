import { nativeChatMessageCopyText } from '../messages/native-chat-message-copy-text'
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

it('keeps generated viewing-copy context out of drawn and copied words while preserving human notes', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const generated: NativeChatMessage = {
    id: 'generated',
    role: 'user',
    blocks: [
      { type: 'image-ref', path: '/temp/a.png' },
      { type: 'text', text: `Inspect this\n\n${note}` }
    ],
    timestamp: 1,
    source: 'transcript'
  }
  expect(nativeChatMessageCopyText(generated)).toBe('Inspect this')
  expect(nativeChatMessageCopyText({ ...generated, blocks: [{ type: 'text', text: note }] })).toBe(
    note
  )
  expect(generated.blocks).toHaveLength(2)
})

it.each([false, true])(
  'removes multiple fitted-drop contexts before a caption (separate blocks=%s)',
  (separate) => {
    const a = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
    const b = '[Image source file: "/repo/b.png"; attached viewing copy: "/temp/b.png"]'
    const message: NativeChatMessage = {
      id: 'drop',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        { type: 'image-ref', path: '/temp/a.png' },
        { type: 'image-ref', path: '/temp/b.png' },
        ...(separate
          ? [
              { type: 'text' as const, text: a },
              { type: 'text' as const, text: `${b} Describe these` }
            ]
          : [{ type: 'text' as const, text: `${a} ${b} Describe these` }])
      ]
    }
    expect(nativeChatMessageCopyText(message)).toBe('Describe these')
  }
)

it('preserves a human source-note caption while removing only the matching generated suffix', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const message: NativeChatMessage = {
    id: 'caption',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'image-ref', path: '/temp/a.png' },
      { type: 'text', text: `${note}\n\n${note}` }
    ]
  }
  expect(nativeChatMessageCopyText(message)).toBe(note)
})

it.each([true, false])(
  'removes only a fitted image context beside an unchanged image (fitted first=%s)',
  (first) => {
    const note = '[Image source file: "/repo/big.png"; attached viewing copy: "/temp/big.png"]'
    const paths = first
      ? ['/temp/big.png', '/repo/small.png']
      : ['/repo/small.png', '/temp/big.png']
    const message: NativeChatMessage = {
      id: 'mixed',
      role: 'user',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        ...paths.map((path) => ({ type: 'image-ref' as const, path })),
        { type: 'text', text: `${note} Describe these` }
      ]
    }
    expect(nativeChatMessageCopyText(message)).toBe('Describe these')
  }
)

it('preserves a human note inside a caption beside an image with no path', () => {
  const text = 'Why did it add [Image source file: "/a.png"; attached viewing copy: "/b.png"] here?'
  const message: NativeChatMessage = {
    id: 'literal',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [
      { type: 'image-ref', url: 'data:image/png;base64,abc' },
      { type: 'text', text }
    ]
  }
  expect(nativeChatMessageCopyText(message)).toBe(text)
})
