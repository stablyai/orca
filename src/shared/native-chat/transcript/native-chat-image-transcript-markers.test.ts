import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { imageReferenceToken } from '../native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  imageSourcePathFromText,
  promptMarkersToImageReferences,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  stripSentImagePromptMarkers,
  withoutSentImagePromptMarkers
} from './native-chat-image-transcript-markers'
import { formatNativeChatFileReference } from '../../agent-image-paste'

function userText(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('imageSourcePathFromText', () => {
  it.each([
    ['[Image: source: /tmp/a.png]', '/tmp/a.png'],
    ['[Image:\nsource:\n\t/tmp/a.png] \n', '/tmp/a.png'],
    ['[Image: source: /tmp/with ] brackets.png]', '/tmp/with ] brackets.png'],
    ['[Image: source: ]', ''],
    ['[Image: source:\n ]', ''],
    ['[Image: source:\t]', ''],
    ['[Image: source:]', null],
    ['[Image: source:\n]', null],
    ['[Image: source: /tmp/a\nb.png]', null],
    ['[Image: source: /tmp/a.png\n]', null],
    ['[Image: source: /tmp/a.png] trailing text', null]
  ])('preserves marker whitespace and bracket rules for %j', (text, path) => {
    expect(imageSourcePathFromText(text)).toBe(path)
  })
})

describe('normalizeImageTranscriptMessages', () => {
  it('merges a source turn into a prompt with a trailing image marker', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/orca-paste-1-2.png]'),
      userText('b', 'describe this[Image #1]')
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/orca-paste-1-2.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

  it('folds and strips markers in later text blocks', () => {
    const prompt: NativeChatMessage = {
      ...userText('prompt', 'unused'),
      blocks: [
        { type: 'text', text: 'describe' },
        { type: 'image-ref', path: '/tmp/existing.png' },
        { type: 'text', text: '[Image #1] this' }
      ]
    }
    const out = normalizeImageTranscriptMessages([
      userText('source', '[Image: source: /tmp/a.png]'),
      prompt
    ])

    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'describe' },
      { type: 'image-ref', path: '/tmp/existing.png' },
      { type: 'text', text: 'this' }
    ])
  })

  it('recognizes only sole-text image-source user turns', () => {
    const source = userText('source', '[Image: source: /tmp/a.png]')
    expect(isImageSourceUserTurn(source)).toBe(true)
    expect(isImageSourceUserTurn({ ...source, role: 'assistant' })).toBe(false)
    expect(
      isImageSourceUserTurn({
        ...source,
        blocks: [...source.blocks, { type: 'text', text: 'caption' }]
      })
    ).toBe(false)
  })

  it('folds every source and strips every prompt marker for a multi-image send', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/a.png]'),
      userText('b', '[Image: source: /tmp/b.png]'),
      userText('c', '[Image: source: /tmp/c.png]'),
      userText('prompt', '[Image #1] [Image #2] [Image #3] compare these')
    ])

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'prompt' })
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'image-ref', path: '/tmp/c.png' },
      { type: 'text', text: 'compare these' }
    ])
  })

  it('keeps all image refs when a multi-image send has no caption', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/a.png]'),
      userText('b', '[Image: source: /tmp/b.png]'),
      userText('prompt', '[Image #1] [Image #2]')
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' }
    ])
  })

  it('preserves adjacent standalone image turns without a prompt marker', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/a.png]'),
      userText('b', '[Image: source: /tmp/b.png]')
    ])

    expect(out).toHaveLength(2)
    expect(out.map((message) => message.id)).toEqual(['a', 'b'])
    expect(out.map((message) => message.blocks)).toEqual([
      [{ type: 'image-ref', path: '/tmp/a.png' }],
      [{ type: 'image-ref', path: '/tmp/b.png' }]
    ])
  })

  it('folds a multi-block companion turn into one turn carrying every ref', () => {
    // Claude emits one companion message with multiple source blocks; single-block matching missed multi-image pastes.
    const out = normalizeImageTranscriptMessages([
      {
        id: 'companion',
        role: 'user',
        blocks: [
          { type: 'text', text: '[Image: source: /tmp/a.png]' },
          { type: 'text', text: '[Image: source: /tmp/b.png]' }
        ],
        timestamp: 1,
        source: 'transcript'
      }
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' }
    ])
  })

  it('does not treat a turn mixing prose with a marker as an image-source turn', () => {
    const messages = [
      {
        id: 'mixed',
        role: 'user' as const,
        blocks: [
          { type: 'text' as const, text: '[Image: source: /tmp/a.png]' },
          { type: 'text' as const, text: 'and here is what I think' }
        ],
        timestamp: 1,
        source: 'transcript' as const
      }
    ]
    const out = normalizeImageTranscriptMessages(messages)

    expect(out[0]!.blocks.some((block) => block.type === 'image-ref')).toBe(false)
  })

  it('leaves assistant messages untouched', () => {
    const assistant: NativeChatMessage = {
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: '[Image: source: /tmp/x.png]' }],
      timestamp: 1,
      source: 'transcript'
    }
    expect(normalizeImageTranscriptMessages([assistant])).toEqual([assistant])
  })
})

describe('normalizeNativeChatUserText control bytes', () => {
  // Remove a bracketed-paste wrapper as one sequence so its printable tail cannot survive.
  it('drops a bracketed-paste wrapper, not just its ESC introducer', () => {
    expect(normalizeNativeChatUserText('\u001b[200~/tmp/orca-paste-1.png\u001b[201~')).toBe(
      '/tmp/orca-paste-1.png'
    )
  })

  it('preserves bracketed-paste-looking text without an ESC introducer', () => {
    expect(normalizeNativeChatUserText('[200~literal[201~')).toBe('[200~literal[201~')
  })
})

describe('composer image chips at send and back', () => {
  const chip = imageReferenceToken

  it('numbers each chip by its image’s place among the images sent', () => {
    expect(
      imageReferencesToPromptMarkers(`after ${chip('b')} before ${chip('a')} again ${chip('b')}`, [
        'a',
        'b'
      ])
    ).toBe('after [Image #2] before [Image #1] again [Image #2]')
  })

  it('drops a chip whose image is not sent, and counts an image with no chip', () => {
    expect(imageReferencesToPromptMarkers(`${chip('gone')}see ${chip('c')}`, ['a', 'c'])).toBe(
      'see [Image #2]'
    )
  })

  it('leaves typed text alone, even a typed marker or a path holding one', () => {
    const text = 'compare [Image #2] with @/tmp/[Image #2].md and [Image](orca-image:bad id)'
    expect(imageReferencesToPromptMarkers(text, ['a', 'b'])).toBe(text)
  })

  it('turns a returned message’s markers back into chips for its own images', () => {
    expect(
      promptMarkersToImageReferences('[Image #2] then [Image #1], not [Image #3]', ['r-1', 'r-3'])
    ).toBe(`${chip('r-3')} then ${chip('r-1')}, not [Image #3]`)
  })

  it('strips only the markers its images have, leaving a typed one past them', () => {
    expect(stripSentImagePromptMarkers('[Image #1] then [Image #2], not [Image #3]', 2)).toBe(
      'then , not [Image #3]'
    )
    expect(stripSentImagePromptMarkers('Explain the literal token [Image #1]', 0)).toBe(
      'Explain the literal token [Image #1]'
    )
  })

  it('leaves a quoted file path that reads like a marker as typed, back or stripped', () => {
    const files = [
      formatNativeChatFileReference('/repo/[Image #1].md'),
      formatNativeChatFileReference('/repo/"q" [Image #1].md'),
      formatNativeChatFileReference('/repo/"q" \'s\' [Image #1].md')
    ]
    for (const file of files) {
      expect(promptMarkersToImageReferences(`[Image #1] in ${file}`, ['r-1'])).toBe(
        `${chip('r-1')} in ${file}`
      )
      expect(stripSentImagePromptMarkers(`[Image #1] in ${file} [Image #1]`, 1)).toBe(`in ${file}`)
    }
  })

  it('leaves literal markers inside inline backticks and fenced code blocks untouched', () => {
    expect(
      stripSentImagePromptMarkers(
        '[Image #1] why does `[Image #1]` and `` `[Image #1]` `` appear?',
        1
      )
    ).toBe('why does `[Image #1]` and `` `[Image #1]` `` appear?')
    expect(
      promptMarkersToImageReferences(
        '[Image #1] why does `[Image #1]` and `` `[Image #1]` `` appear?',
        ['r-1']
      )
    ).toBe(`${chip('r-1')} why does \`[Image #1]\` and \`\` \`[Image #1]\` \`\` appear?`)

    // Unclosed stray backtick must not swallow a real sent marker after it.
    expect(stripSentImagePromptMarkers('Don`t show [Image #1]', 1)).toBe('Don`t show')

    const fenced = ['[Image #1]', '```md', '[Image #1]', '```', '~~~', '[Image #1]', '~~~'].join(
      '\n'
    )
    expect(stripSentImagePromptMarkers(fenced, 1)).toBe(
      ['', '```md', '[Image #1]', '```', '~~~', '[Image #1]', '~~~'].join('\n')
    )
    expect(promptMarkersToImageReferences(fenced, ['r-1'])).toBe(
      [chip('r-1'), '```md', '[Image #1]', '```', '~~~', '[Image #1]', '~~~'].join('\n')
    )
  })
})

describe('withoutSentImagePromptMarkers', () => {
  const sent = (text: string, images: number, role: NativeChatMessage['role'] = 'user') => ({
    id: 'm',
    role,
    blocks: [
      { type: 'text' as const, text },
      ...Array.from({ length: images }, (_, i) => ({
        type: 'image-ref' as const,
        path: `/tmp/${i}.png`
      }))
    ],
    timestamp: 1,
    source: 'transcript' as const
  })

  it('drops a marker from the middle of the words, not only the start', () => {
    expect(
      withoutSentImagePromptMarkers(sent('然后图片下面自带 [Image #1] 。如果不在开头', 1))[0]
    ).toEqual({
      type: 'text',
      text: '然后图片下面自带  。如果不在开头'
    })
    expect(withoutSentImagePromptMarkers(sent('[Image #1] 就像这样', 1))[0]).toEqual({
      type: 'text',
      text: '就像这样'
    })
  })

  it('drops the blank line a marker alone on the first or last line leaves', () => {
    expect(
      withoutSentImagePromptMarkers(sent('[Image #1]\r\nexplain\n  this\n[Image #2]', 2))[0]
    ).toEqual({
      type: 'text',
      text: 'explain\n  this'
    })
  })

  it('drops a text block left with nothing but its markers, returning the same array each call', () => {
    const message = sent('[Image #1] [Image #2]', 2)
    expect(withoutSentImagePromptMarkers(message)).toEqual([
      { type: 'image-ref', path: '/tmp/0.png' },
      { type: 'image-ref', path: '/tmp/1.png' }
    ])
    expect(withoutSentImagePromptMarkers(message)).toBe(withoutSentImagePromptMarkers(message))
  })

  it('keeps a marker past the message images, code-quoted markers, and imageless or agent rows', () => {
    expect(withoutSentImagePromptMarkers(sent('see [Image #2]', 1))[0]).toEqual({
      type: 'text',
      text: 'see [Image #2]'
    })
    expect(withoutSentImagePromptMarkers(sent('[Image #1]\n```md\n[Image #1]\n```', 1))[0]).toEqual(
      {
        type: 'text',
        text: '```md\n[Image #1]\n```'
      }
    )
    const imageless = sent('see [Image #1]', 0)
    expect(withoutSentImagePromptMarkers(imageless)).toBe(imageless.blocks)
    const agent = sent('see [Image #1]', 1, 'assistant')
    expect(withoutSentImagePromptMarkers(agent)).toBe(agent.blocks)
  })
})
