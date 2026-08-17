import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import {
  isImageSourceUserTurn,
  nativeChatUserMessageImageEvidenceCount,
  nativeChatUserMessageMatchText,
  nativeChatUserTextMatchText,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText,
  stripImagePromptMarker
} from './native-chat-image-transcript-markers'

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

  it('keeps markers in no-image match keys without changing real image keys', () => {
    expect(nativeChatUserTextMatchText(' keep [Image #1] literal ', false)).toBe(
      'keep [Image #1] literal'
    )
    expect(nativeChatUserTextMatchText(' keep [Image #1] literal ', true)).toBe('keep literal')

    const literal = userText('literal', 'keep [Image #1] literal')
    const attached = {
      ...literal,
      blocks: [{ type: 'image-ref' as const, path: '/tmp/a.png' }, ...literal.blocks]
    }
    expect(nativeChatUserMessageMatchText(literal)).toBe('keep [Image #1] literal')
    expect(nativeChatUserMessageMatchText(attached)).toBe('keep literal')
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

  it('leaves ordinary user text untouched', () => {
    const message = userText('a', 'keep [Image #1] as literal text')
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

  it('keeps a later literal marker when earlier turns separate it from a real image send', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.jpg]'),
      userText('p1', '[Image #1] what is this?'),
      userText('u1', 'thanks'),
      userText('u2', 'in my notes I wrote [Image #2] as plain text')
    ])

    expect(out.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'in my notes I wrote [Image #2] as plain text' }
    ])
  })

  it('breaks the anchor when a non-image user turn separates the source run from the prompt', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.jpg]'),
      userText('u1', 'here is the picture'),
      userText('u2', 'please preserve [Image #1] literally')
    ])

    expect(out.map((message) => message.blocks)).toEqual([
      [{ type: 'image-ref', path: '/tmp/a.jpg' }],
      [{ type: 'text', text: 'here is the picture' }],
      [{ type: 'text', text: 'please preserve [Image #1] literally' }]
    ])
  })

  // A marker the user typed must not absorb the image of the send that follows it.
  it('does not let a literal marker turn claim a later send’s image source', () => {
    const out = normalizeImageTranscriptMessages([
      userText('u1', 'remember I typed [Image #1] by hand'),
      userText('s1', '[Image: source: /tmp/a.jpg]'),
      userText('p1', '[Image #1] what is this?')
    ])

    expect(out[0]?.blocks).toEqual([{ type: 'text', text: 'remember I typed [Image #1] by hand' }])
    expect(out.at(-1)?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.jpg' },
      { type: 'text', text: 'what is this?' }
    ])
  })

  it('keeps markers beyond the anchored run’s image count as the user’s own words', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.png]'),
      userText('p1', '[Image #1] compare with the [Image #2] I mentioned earlier')
    ])

    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'compare with the [Image #2] I mentioned earlier' }
    ])
  })

  it('strips by document position, not by marker ordinal', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.png]'),
      userText('p1', '[Image #2] came first but [Image #1] came second')
    ])

    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'came first but [Image #1] came second' }
    ])
  })

  it('strips a marker whose ordinal exceeds the run size when it is within the count', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.png]'),
      userText('p1', '[Image #7] what is this?')
    ])

    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'what is this?' }
    ])
  })

  it('spends the image budget across text blocks in document order', () => {
    const prompt: NativeChatMessage = {
      ...userText('prompt', 'unused'),
      blocks: [
        { type: 'text', text: '[Image #1] look at' },
        { type: 'image-ref', path: '/tmp/existing.png' },
        { type: 'text', text: 'not [Image #2] though' }
      ]
    }
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.png]'),
      prompt
    ])

    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'look at' },
      { type: 'image-ref', path: '/tmp/existing.png' },
      { type: 'text', text: 'not [Image #2] though' }
    ])
  })

  it('keeps the surplus marker on a two-image run that mentions a third', () => {
    const out = normalizeImageTranscriptMessages([
      userText('s1', '[Image: source: /tmp/a.png]'),
      userText('s2', '[Image: source: /tmp/b.png]'),
      userText('p1', '[Image #1] [Image #2] versus the [Image #3] from before')
    ])

    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'versus the [Image #3] from before' }
    ])
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

// The read window is a hard count slice (`boundNativeChatWindow`), so as a session
// ages past the limit its head cuts straight through `[Image: source: …]` runs.
// Without the paging signal the fold reads a trimmed run as "the user typed these
// markers" and leaks agent-internal markup into a message they already sent.
describe('normalizeImageTranscriptMessages with earlier history above the window', () => {
  it('strips markers from a head prompt whose whole source run was trimmed', () => {
    const out = normalizeImageTranscriptMessages([userText('b', '[Image #1] what do you see')], {
      windowHeadMessageId: 'b'
    })
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'what do you see' }])
  })

  it('spends an unbounded budget on a run that starts at the window head', () => {
    const out = normalizeImageTranscriptMessages(
      [
        userText('a', '[Image: source: /tmp/b.png]'),
        userText('b', '[Image #1] [Image #2] compare these')
      ],
      { windowHeadMessageId: 'a' }
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'compare these' }
    ])
  })

  // Why: only the head is ambiguous. Anywhere else the source run would be visible
  // above the prompt, so its absence really is proof the markers are user text —
  // this is the STA-4363 case and it must survive the paging signal.
  it('keeps literal markers verbatim when the turn is not at the window head', () => {
    const out = normalizeImageTranscriptMessages(
      [
        { ...userText('a', 'hello'), role: 'assistant' as const },
        userText('b', 'use [Image #1] as a label')
      ],
      { windowHeadMessageId: 'a' }
    )
    expect(out[1]!.blocks).toEqual([{ type: 'text', text: 'use [Image #1] as a label' }])
  })

  it('keeps a head prompt verbatim when no older history exists', () => {
    const out = normalizeImageTranscriptMessages([userText('b', '[Image #1] what do you see')], {})
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: '[Image #1] what do you see' }])
  })

  it('still bounds the strip by image count for a run below the head', () => {
    const out = normalizeImageTranscriptMessages(
      [
        { ...userText('z', 'earlier'), role: 'assistant' as const },
        userText('a', '[Image: source: /tmp/b.png]'),
        userText('b', '[Image #1] compare with the [Image #2] I mentioned')
      ],
      { windowHeadMessageId: 'z' }
    )
    expect(out[1]!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'compare with the [Image #2] I mentioned' }
    ])
  })

  // Why: the head is named by id, never by position. Callers pass lists that were
  // merged across sources and re-sorted, so index 0 is whichever row sorts first:
  // an unpaginated scrape/hook row, or — for a transcript with no timestamps —
  // the lexicographically smallest id. Stripping either would delete user text.
  it('ignores a row that merely sorts first but is not the named head', () => {
    const out = normalizeImageTranscriptMessages(
      [
        { ...userText('aaa-scrape', 'typed [Image #1] literally'), source: 'scrape' as const },
        userText('zzz-head', '[Image #1] what do you see')
      ],
      { windowHeadMessageId: 'zzz-head' }
    )
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'typed [Image #1] literally' }])
    expect(out[1]!.blocks).toEqual([{ type: 'text', text: 'what do you see' }])
  })

  // Why: the remote read casts host frames without validating per-message fields,
  // so a row can reach the fold with no id. Comparing ids alone let that row match
  // an absent option and strip a marker the user typed, with no window head at all.
  it('never treats an id-less row as the head when no head is named', () => {
    // Cast because the type says `id: string`; only the unvalidated remote read
    // can produce this, which is exactly why the guard has to exist at runtime.
    const idLess = {
      ...userText('x', 'what does [Image #1] mean?'),
      id: undefined
    } as unknown as NativeChatMessage
    const out = normalizeImageTranscriptMessages([idLess], {})
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'what does [Image #1] mean?' }])
  })

  it('does nothing when the named head is not in the list', () => {
    const out = normalizeImageTranscriptMessages([userText('b', '[Image #1] what do you see')], {
      windowHeadMessageId: 'some-other-row'
    })
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: '[Image #1] what do you see' }])
  })
})

// The strip is bounded to the size of the run it anchors to, so a folded image
// row can now KEEP markers the user typed. Counting those as photos would let a
// row rendering one image vouch for two sends and retire the wrong one.
describe('nativeChatUserMessageImageEvidenceCount', () => {
  it('counts the photos a row shows, not the markers it kept', () => {
    const [row] = normalizeImageTranscriptMessages([
      userText('a', '[Image: source: /tmp/x.png]'),
      userText('b', '[Image #1] look [Image #2] [Image #3]')
    ])
    // The fold spent its one-image budget and left the two surplus markers.
    expect(row!.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/x.png' },
      { type: 'text', text: 'look [Image #2] [Image #3]' }
    ])
    expect(nativeChatUserMessageImageEvidenceCount(row!)).toBe(1)
  })

  it('still reads markers as evidence when the turn shows no image at all', () => {
    // A host that echoes an image send as bare `[Image #n]` with no source turn
    // leaves the markers as the only proof the photos landed.
    expect(nativeChatUserMessageImageEvidenceCount(userText('c', '[Image #1] [Image #2]'))).toBe(2)
  })

  it('ignores an assistant turn', () => {
    const assistantTurn = { ...userText('d', '[Image #1]'), role: 'assistant' as const }
    expect(nativeChatUserMessageImageEvidenceCount(assistantTurn)).toBe(0)
  })
})
