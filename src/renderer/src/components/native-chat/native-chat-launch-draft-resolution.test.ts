import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  launchDraftResolvedByTranscript,
  nativeChatLaunchDraftTurnBaseline
} from './native-chat-launch-draft-resolution'

function userMessage(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

function assistantMessage(id: string, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    timestamp: 2,
    source: 'transcript'
  }
}

describe('launchDraftResolvedByTranscript', () => {
  const SEEDED_AT = 100_000

  it('resolves on any user turn at or after the seed time, even with different text', () => {
    // The TUI input holds one line: a later user turn means the prefill was
    // submitted with that turn (possibly edited/concatenated) or cleared first.
    const submitted = { ...userMessage('u1', 'unrelated text'), timestamp: SEEDED_AT + 5_000 }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [submitted])).toBe(true)
  })

  it('ignores assistant turns and user turns from before the seed', () => {
    const early = { ...userMessage('u1', 'old turn'), timestamp: SEEDED_AT - 50_000 }
    const reply = { ...assistantMessage('a1', 'hello'), timestamp: SEEDED_AT + 5_000 }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [early, reply])).toBe(false)
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [])).toBe(false)
  })

  it('resolves on undated user turns (Grok omits row timestamps)', () => {
    const undated = { ...userMessage('u1', 'submitted in the TUI'), timestamp: null }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [undated])).toBe(true)
  })

  it('resolves when the executing host clock trails the renderer within the slack', () => {
    // SSH/remote workspaces stamp the JSONL on the other host's clock.
    const behind = { ...userMessage('u1', 'submitted'), timestamp: SEEDED_AT - 1_500 }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [behind])).toBe(true)
  })

  it('resolves past wider clock skew once a new tail user turn lands', () => {
    const stale = { ...userMessage('u1', 'earlier turn'), timestamp: SEEDED_AT - 600_000 }
    const baseline = { userTurnCount: 1, lastUserTurnId: 'u1' }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [stale], baseline)).toBe(false)

    const next = { ...userMessage('u2', 'submitted'), timestamp: SEEDED_AT - 600_000 + 10 }
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, [stale, next], baseline)).toBe(
      true
    )
  })

  it('does not resolve when "load earlier" only prepends history', () => {
    const tail = { ...userMessage('u9', 'earlier turn'), timestamp: SEEDED_AT - 600_000 }
    const baseline = { userTurnCount: 1, lastUserTurnId: 'u9' }
    const paged = [
      { ...userMessage('u7', 'older'), timestamp: SEEDED_AT - 900_000 },
      { ...userMessage('u8', 'older'), timestamp: SEEDED_AT - 800_000 },
      tail
    ]
    expect(launchDraftResolvedByTranscript({ createdAt: SEEDED_AT }, paged, baseline)).toBe(false)
  })
})

describe('nativeChatLaunchDraftTurnBaseline', () => {
  it('snapshots the user-turn count and tail id, ignoring assistant turns', () => {
    expect(
      nativeChatLaunchDraftTurnBaseline([
        userMessage('u1', 'one'),
        assistantMessage('a1', 'reply'),
        userMessage('u2', 'two')
      ])
    ).toEqual({ userTurnCount: 2, lastUserTurnId: 'u2' })
    expect(nativeChatLaunchDraftTurnBaseline([])).toEqual({
      userTurnCount: 0,
      lastUserTurnId: null
    })
  })
})
