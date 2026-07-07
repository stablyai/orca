import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
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

// Drive the incremental assembler over base + each append batch, capturing the
// emitted list after every batch so we can compare each prefix to a full rebuild.
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
  // An adversarial append sequence exercising every hard case the design calls
  // out: re-emitted ids, transcript-supersedes-hook, turnKey collisions,
  // out-of-order + null timestamps, empty batches.
  const base: NativeChatMessage[] = [
    msg({ id: 'a', timestamp: 10, role: 'user', blocks: [{ type: 'text', text: 'hello' }] }),
    msg({ id: 'b', timestamp: 20, blocks: [{ type: 'text', text: 'partial' }], source: 'hook' })
  ]

  const batches: NativeChatMessage[][] = [
    // pure tail append (fast path)
    [msg({ id: 'c', timestamp: 30, blocks: [{ type: 'text', text: 'c' }] })],
    // empty batch
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
    // turnKey collision with 'a': same role+text+timestamp, DIFFERENT source
    // (scrape) — lower priority, must be dropped by the cross-source gate
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
    // re-emitted id at the tail (already seen 'c'), no change
    [msg({ id: 'c', timestamp: 30, blocks: [{ type: 'text', text: 'c' }] })],
    // multi-message tail batch
    [
      msg({ id: 'g', timestamp: 50, blocks: [{ type: 'text', text: 'g' }] }),
      msg({ id: 'h', timestamp: 60, blocks: [{ type: 'text', text: 'h' }] })
    ]
  ]

  it('matches a full rebuild for every prefix of the append sequence', () => {
    const inc = incrementalPrefixes(base, batches)
    let cumulative = [...base]
    // Prefix 0 = base only.
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
})
