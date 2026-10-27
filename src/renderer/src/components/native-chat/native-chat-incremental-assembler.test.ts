import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { normalizeImageTranscriptMessages } from '../../../../shared/native-chat-image-transcript-markers'
import { assembleNativeChatSession } from './native-chat-session-assembler'
import {
  applyAppends,
  createIncrementalAssembler,
  reset
} from './native-chat-incremental-assembler'

function msg(
  overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
): NativeChatMessage {
  return {
    role: 'assistant',
    blocks: [{ type: 'text', text: overrides.id }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

// Canonical reference: assemble the full transcript from scratch.
function fullRebuild(messages: NativeChatMessage[]): NativeChatMessage[] {
  return assembleNativeChatSession({
    sources: { transcript: messages },
    sessionId: 's1',
    agent: 'claude'
  }).messages
}

// Compare every append prefix with the canonical full rebuild.
function incrementalPrefixes(
  base: NativeChatMessage[],
  batches: NativeChatMessage[][]
): NativeChatMessage[][] {
  const assembler = createIncrementalAssembler()
  const out: NativeChatMessage[][] = []
  out.push(reset(assembler, base))
  for (const batch of batches) {
    out.push(applyAppends(assembler, batch))
  }
  return out
}

describe('incremental assembler — oracle differential', () => {
  const base: NativeChatMessage[] = [
    msg({ id: 'a', timestamp: 10, role: 'user', blocks: [{ type: 'text', text: 'hello' }] }),
    msg({ id: 'b', timestamp: 20, blocks: [{ type: 'text', text: 'partial' }], source: 'hook' })
  ]

  const batches: NativeChatMessage[][] = [
    [msg({ id: 'c', timestamp: 30, blocks: [{ type: 'text', text: 'c' }] })],
    [],
    // re-emit id 'b' from transcript — supersedes the hook copy in place
    [
      msg({
        id: 'b',
        timestamp: 20,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'final' }]
      })
    ],
    // out-of-order timestamp: sorts BEFORE the current tail → forces re-sort
    [msg({ id: 'd', timestamp: 5, blocks: [{ type: 'text', text: 'early' }] })],
    // A lower-priority scrape with the same turn identity must lose to transcript data.
    [
      msg({
        id: 'a-scrape',
        timestamp: 10,
        role: 'user',
        source: 'scrape',
        blocks: [{ type: 'text', text: 'hello' }]
      })
    ],
    // same-source identical prompt (distinct id) — must NOT collapse (#10)
    [msg({ id: 'e', timestamp: 40, role: 'user', blocks: [{ type: 'text', text: 'hello' }] })],
    // null timestamp append → forces re-sort, sorts to the front
    [msg({ id: 'f', timestamp: null, blocks: [{ type: 'text', text: 'f' }] })],
    [msg({ id: 'c', timestamp: 30, blocks: [{ type: 'text', text: 'c' }] })],
    [
      msg({ id: 'g', timestamp: 50, blocks: [{ type: 'text', text: 'g' }] }),
      msg({ id: 'h', timestamp: 60, blocks: [{ type: 'text', text: 'h' }] })
    ]
  ]

  it('matches a full rebuild for every prefix of the append sequence', () => {
    const inc = incrementalPrefixes(base, batches)
    let cumulative = [...base]
    expect(inc[0]).toEqual(fullRebuild(cumulative))
    for (let i = 0; i < batches.length; i += 1) {
      cumulative = [...cumulative, ...batches[i]!]
      expect(inc[i + 1]).toEqual(fullRebuild(cumulative))
    }
  })

  it('keeps prior message object identity on a pure tail append', () => {
    const assembler = createIncrementalAssembler()
    reset(assembler, base)
    const before = assembler.messages
    const tail = msg({ id: 'z', timestamp: 99, blocks: [{ type: 'text', text: 'z' }] })
    const after = applyAppends(assembler, [tail])
    // New array reference (React needs it) but the existing rows keep identity.
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after.at(-1)).toBe(tail)
  })

  it('returns the same reference for an empty append batch', () => {
    const assembler = createIncrementalAssembler()
    reset(assembler, base)
    const out = assembler.messages
    expect(applyAppends(assembler, [])).toBe(out)
  })

  it('keeps equal-timestamp image companions ahead of prompts for normalization', () => {
    const assembler = createIncrementalAssembler()
    const prompt = msg({
      id: 'a-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect this' }]
    })
    const companion = msg({
      id: 'z-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/image.png]' }]
    })

    const assembled = reset(assembler, [prompt, companion])
    expect(assembled.map((message) => message.id)).toEqual(['z-companion', 'a-prompt'])
    expect(normalizeImageTranscriptMessages(assembled)).toEqual([
      {
        ...prompt,
        blocks: [
          { type: 'image-ref', path: '/tmp/image.png' },
          { type: 'text', text: 'inspect this' }
        ]
      }
    ])
  })

  it('does not cross-fold distinct equal-timestamp image turns', () => {
    const assembler = createIncrementalAssembler()
    const firstPrompt = msg({
      id: 'a-first-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect the first' }]
    })
    const firstCompanion = msg({
      id: 'z-first-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/first.png]' }]
    })
    const secondPrompt = msg({
      id: 'b-second-prompt',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image #1] inspect the second' }]
    })
    const secondCompanion = msg({
      id: 'y-second-companion',
      role: 'user',
      timestamp: 100,
      blocks: [{ type: 'text', text: '[Image: source: /tmp/second.png]' }]
    })

    const assembled = reset(assembler, [firstPrompt, firstCompanion, secondPrompt, secondCompanion])

    expect(normalizeImageTranscriptMessages(assembled)).toEqual([
      {
        ...firstPrompt,
        blocks: [
          { type: 'image-ref', path: '/tmp/first.png' },
          { type: 'text', text: 'inspect the first' }
        ]
      },
      {
        ...secondPrompt,
        blocks: [
          { type: 'image-ref', path: '/tmp/second.png' },
          { type: 'text', text: 'inspect the second' }
        ]
      }
    ])
  })
})

it('bounds new canonical append decision work by the incoming batch at N and 10N, including null clocks', () => {
  const counts = [100, 1000].map((size) => {
    let reads = 0
    const base = Array.from({ length: size }, (_, i) => ({
      ...msg({ id: `file-${i}`, timestamp: null }),
      get transcriptOrder() {
        reads += 1
        return i
      }
    }))
    const assembler = createIncrementalAssembler()
    reset(assembler, base)
    reads = 0
    applyAppends(assembler, [{ ...msg({ id: 'next', timestamp: null }), transcriptOrder: size }])
    expect(assembler.messages.at(-1)?.id).toBe('next')
    expect(reads).toBeLessThan(20)
    return reads
  })
  expect(counts[1]).toBeLessThanOrEqual(counts[0] + 1)
})

it('matches a rebuild when supplementals or image units cross a canonical batch boundary', () => {
  const first = { ...msg({ id: 'first', timestamp: 100 }), transcriptOrder: 0 }
  const last = { ...msg({ id: 'last', timestamp: 0 }), transcriptOrder: 10 }
  const supplemental = msg({ id: 'middle', source: 'hook', timestamp: 50 })
  const source = {
    ...msg({
      id: 'source',
      role: 'user',
      blocks: [{ type: 'text', text: '[Image: source: /tmp/one.png]' }]
    }),
    transcriptOrder: 0
  }
  const prompt = {
    ...msg({ id: 'prompt', role: 'user', blocks: [{ type: 'text', text: 'look [Image #1]' }] }),
    transcriptOrder: 10
  }
  const companion = { ...source, id: 'next-source', transcriptOrder: 20 }
  for (const [base, incoming] of [
    [[first, last], [supplemental]],
    [[source], [prompt, companion]]
  ]) {
    const assembler = createIncrementalAssembler()
    reset(assembler, base)
    expect(normalizeImageTranscriptMessages(applyAppends(assembler, incoming))).toEqual(
      fullRebuild([...base, ...incoming])
    )
  }
})
