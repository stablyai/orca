import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_SOURCE_PRIORITY,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { mergeNativeChatMessagesWith } from '../../../../shared/native-chat-merge'
import { assembleNativeChatSession } from './native-chat-session-assembler'

// On single-source (pure transcript) data the desktop assembler's cross-source
// turnKey pass is a no-op, so it must agree with mobile's id-only merge on the
// final id set and order. This locks the "mobile is single-source, so id-only ≡
// assembler-with-same-source-gated-fallback" invariant from the design (#10).

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

describe('assembler ↔ id-merge parity on single-source data', () => {
  it('produces the same ids in the same order as the id-only merge', () => {
    // Includes two identical-text same-source prompts (distinct ids): both must
    // survive in both implementations.
    const transcript: NativeChatMessage[] = [
      msg({ id: 'u1', role: 'user', timestamp: 10, blocks: [{ type: 'text', text: 'run tests' }] }),
      msg({ id: 'a1', timestamp: 20, blocks: [{ type: 'text', text: 'ok' }] }),
      msg({ id: 'u2', role: 'user', timestamp: 30, blocks: [{ type: 'text', text: 'run tests' }] }),
      msg({ id: 'a2', timestamp: 40, blocks: [{ type: 'text', text: 'done' }] })
    ]

    const assembled = assembleNativeChatSession({
      sources: { transcript },
      sessionId: 's1',
      agent: 'claude'
    }).messages
    const merged = mergeNativeChatMessagesWith([], transcript, NATIVE_CHAT_SOURCE_PRIORITY)

    // The assembler sorts by (timestamp, id); the merge preserves arrival order.
    // The fixture's arrival order already matches timestamp order, so ids align.
    expect(assembled.map((m) => m.id)).toEqual(merged.map((m) => m.id))
    expect(assembled).toHaveLength(transcript.length)
  })
})
