import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { imageReferenceToken } from './native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText,
  stripImagePromptMarker,
  stripSentImagePromptMarkers
} from './native-chat-image-transcript-markers'
import { formatNativeChatFileReference } from './agent-image-paste'

function userText(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('normalizeImageTranscriptMessages', () => {
  it('merges the paired [Image: source]/[Image #1] turns into one image-ref turn', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/orca-paste-1-2.png]'),
      userText('b', '[Image #1] describe this')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/orca-paste-1-2.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

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

  it.each([
    ['[Image #1] describe this', 'describe this'],
    ['[Image #1]\t  describe this', 'describe this'],
    [' \t[Image #1] describe this', 'describe this'],
    ['describe this [Image #1]', 'describe this'],
    ['describe this  \t[Image #1]', 'describe this'],
    ['describe this [Image #1]\t  ', 'describe this'],
    ['describe [Image #1] this', 'describe  this'],
    ['describe  [Image #1]\t this', 'describe  \t this'],
    ['describe[Image #1]\t  this', 'describe\t  this'],
    ['describe\n[Image #1]\nthis', 'describe\n\nthis'],
    ['com[Image #1]pare this', 'compare this'],
    ['[Image #1] [Image #2]', ''],
    ['literal [Image #x] text', 'literal [Image #x] text']
  ])('strips image prompt markers anywhere in text', (text, expected) => {
    expect(stripImagePromptMarker(text)).toBe(expected)
  })

  it('returns long marker-free whitespace without regex backtracking', () => {
    const text = ' '.repeat(50_000)
    expect(stripImagePromptMarker(text)).toBe(text)
  })

  it('shares marker-aware text matching across multiple text blocks', () => {
    const message: NativeChatMessage = {
      ...userText('prompt', 'unused'),
      blocks: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', path: '/tmp/a.png' },
        { type: 'text', text: '[Image #1]   here' }
      ]
    }

    expect(normalizeNativeChatUserText(' look [Image #1]   here ')).toBe('look here')
    expect(normalizedNativeChatUserMessageText(message)).toBe('look here')
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

  it('converts a lone [Image: source] turn (no prompt) into an image-ref instead of raw text', () => {
    const out = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /Users/me/Pictures/hero-image-2.png]')
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/Users/me/Pictures/hero-image-2.png' }
    ])
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

  it('leaves ordinary user text untouched', () => {
    const message = userText('a', 'how about this')
    const messages = [message]
    const out = normalizeImageTranscriptMessages(messages)
    expect(out).toBe(messages)
    expect(out[0]).toBe(message)
    expect(out[0]!.blocks).toBe(message.blocks)
  })

  it('removes a whitespace-only first text block', () => {
    const out = normalizeImageTranscriptMessages([userText('a', '   ')])

    expect(out[0]?.blocks).toEqual([])
  })

  it('preserves unaffected rows when another row needs normalization', () => {
    const before = userText('before', 'keep this row')
    const marker = userText('marker', '[Image: source: /tmp/image.png]')
    const after = userText('after', 'keep this row too')
    const messages = [before, marker, after]

    const out = normalizeImageTranscriptMessages(messages)

    expect(out).not.toBe(messages)
    expect(out[0]).toBe(before)
    expect(out[2]).toBe(after)
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
  it('drops the Ctrl+U a TUI pasted in front of the prompt', () => {
    expect(normalizeNativeChatUserText('\u0015run the tests')).toBe('run the tests')
  })

  it('drops control bytes that landed inside the prompt', () => {
    expect(normalizeNativeChatUserText('run\u0015 the\u0000 tests')).toBe('run the tests')
  })

  it('still finds the image marker behind a leading control byte', () => {
    expect(normalizeNativeChatUserText('\u0015[Image #1] describe this')).toBe('describe this')
  })

  // Remove a bracketed-paste wrapper as one sequence so its printable tail cannot survive.
  it('drops a bracketed-paste wrapper, not just its ESC introducer', () => {
    expect(normalizeNativeChatUserText('\u001b[200~/tmp/orca-paste-1.png\u001b[201~')).toBe(
      '/tmp/orca-paste-1.png'
    )
  })

  it('preserves bracketed-paste-looking text without an ESC introducer', () => {
    expect(normalizeNativeChatUserText('[200~literal[201~')).toBe('[200~literal[201~')
  })

  it('leaves tabs, newlines and carriage returns to the whitespace collapse', () => {
    expect(normalizeNativeChatUserText('run\tthe\r\ntests')).toBe('run the tests')
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

  it('sends a returned message with the numbers it had', () => {
    const sent = 'compare [Image #1] with [Image #2]'
    const ids = ['returned-m-1', 'returned-m-2']
    expect(imageReferencesToPromptMarkers(promptMarkersToImageReferences(sent, ids), ids)).toBe(
      sent
    )
  })
})
