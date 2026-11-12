import { expect, it } from 'vitest'
import { generatedImageBlocks } from '../native-chat-generated-image'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatGeneratedImageAnswers } from './native-chat-generated-image-answers'
import { nativeChatTurnFold, nativeChatTurnFoldRow } from './native-chat-turn-fold'

const noEmbeds = () => []
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
function project(messages: NativeChatMessage[], turnKeys = messages.map(() => 'u')) {
  const rows = nativeChatGeneratedImageAnswers(messages, turnKeys, new Set(turnKeys), noEmbeds)
  const fold = nativeChatTurnFold({
    rows: rows.map((message, i) => nativeChatTurnFoldRow(message, turnKeys[i], false)),
    settledTurnKeys: new Set(turnKeys),
    expandedTurnKeys: new Set()
  })
  return rows.filter((_, i) => !fold.foldedRows.has(i))
}

it.each(['before', 'after'])(
  'keeps generated output with final prose when it arrives %s the prose',
  (order) => {
    const image = generated('image')
    const answer = text('answer', 'Here is your elephant.')
    const rows = project([
      text('u', 'Generate an elephant.', 'user'),
      text('work', 'Working.'),
      ...(order === 'before' ? [image, answer] : [answer, image])
    ])
    expect(rows.map((row) => [row.id, row.blocks])).toEqual([
      ['u', [{ type: 'text', text: 'Generate an elephant.' }]],
      [
        'answer',
        [
          { type: 'text', text: 'Here is your elephant.' },
          { type: 'image-ref', path: '/tmp/elephant.png' }
        ]
      ]
    ])
  }
)

it('retains image-only output beside a failure and preserves the error notice', () => {
  const failure = {
    ...text('error', 'Codex could not finish. Try again.', 'system'),
    blocks: [{ type: 'text' as const, text: 'Codex could not finish. Try again.', tone: 'error' }]
  }
  const rows = project([text('u', 'Generate.', 'user'), generated('image'), failure])
  expect(rows.map((row) => row.id)).toEqual(['u', 'image', 'error'])
  expect(rows[1]!.blocks.filter((block) => block.type === 'image-ref')).toEqual([
    { type: 'image-ref', path: '/tmp/elephant.png' }
  ])
  expect(rows[2]).toBe(failure)
})

it('keeps send-back outputs in their own answer segments and turn/producer scopes', () => {
  const hook = {
    ...text('hook', 'Continue.', 'system'),
    blocks: [{ type: 'text' as const, text: 'Continue.', presentation: 'hook-sent-back' }]
  }
  const child = { ...generated('child', '/tmp/child.png'), agentId: 'child' }
  const rows = project(
    [
      text('u', 'Generate.', 'user'),
      generated('first', '/tmp/first.png'),
      text('a1', 'First.'),
      hook,
      child,
      generated('second', '/tmp/second.png'),
      text('a2', 'Second.'),
      text('u2', 'Another turn.', 'user'),
      text('a3', 'Other turn.')
    ],
    ['u', 'u', 'u', 'u', 'u', 'u', 'u', 'u2', 'u2']
  )
  expect(rows.find((row) => row.id === 'a1')?.blocks).toEqual([
    { type: 'text', text: 'First.' },
    { type: 'image-ref', path: '/tmp/first.png' }
  ])
  expect(rows.find((row) => row.id === 'a2')?.blocks).toEqual([
    { type: 'text', text: 'Second.' },
    { type: 'image-ref', path: '/tmp/second.png' }
  ])
  expect(rows.find((row) => row.id === 'a3')?.blocks).toEqual([
    { type: 'text', text: 'Other turn.' }
  ])
  expect(
    rows.find((row) => row.id === 'child')?.blocks.filter((block) => block.type === 'image-ref')
  ).toEqual([{ type: 'image-ref', path: '/tmp/child.png' }])
})

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

it('leaves viewed images as work and preserves untouched messages across another turn update', () => {
  const viewed = {
    ...text('view', 'Viewed image'),
    blocks: [
      { type: 'text' as const, text: 'Viewed image' },
      { type: 'image-ref' as const, path: '/tmp/input.png' }
    ]
  }
  const answer = text('answer', 'Finished.')
  expect(project([text('u', 'Inspect.', 'user'), viewed, answer]).map((row) => row.id)).toEqual([
    'u',
    'answer'
  ])
  const messages = [generated('image'), answer, text('other', 'Streaming.')]
  const keys = ['u', 'u', 'other']
  const first = nativeChatGeneratedImageAnswers(messages, keys, new Set(['u']), noEmbeds)
  const next = nativeChatGeneratedImageAnswers(
    [messages[0]!, answer, text('other', 'Streaming more.')],
    keys,
    new Set(['u']),
    noEmbeds
  )
  expect(next[0]).toBe(first[0])
  expect(next[1]).toBe(first[1])
  expect(nativeChatGeneratedImageAnswers(messages, keys, new Set(), noEmbeds)).toBe(messages)
})

it.each([1000, 10000])(
  'bounds unrelated streaming work at %i loaded rows without reparsing completed answers',
  (count) => {
    let blockReads = 0
    let parses = 0
    const sources = () => {
      parses += 1
      return []
    }
    const messages = [
      generated('image'),
      ...Array.from({ length: count - 2 }, (_, index) => text(`work-${index}`, 'Working.')),
      text('answer', 'Finished.')
    ].map((message) => {
      const blocks = message.blocks
      return Object.defineProperty(message, 'blocks', {
        get() {
          blockReads += 1
          return blocks
        }
      })
    })
    const keys = [...messages.map(() => 'u'), 'live']
    const first = nativeChatGeneratedImageAnswers(
      [...messages, text('live', 'Streaming.')],
      keys,
      new Set(['u']),
      sources
    )
    blockReads = 0
    parses = 0
    const next = nativeChatGeneratedImageAnswers(
      [...messages, text('live', 'Streaming more.')],
      keys,
      new Set(['u']),
      sources
    )
    // Producing the loaded transcript requires one classification per row; the one generated ref has bounded extra visits.
    expect(blockReads).toBeLessThanOrEqual(count + 8)
    expect(parses).toBe(0)
    expect(next.slice(0, count).every((message, index) => message === first[index])).toBe(true)
  }
)
