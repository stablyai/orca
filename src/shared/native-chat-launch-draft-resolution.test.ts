import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from './native-chat-types'
import { launchDraftResolvedByTranscript } from './native-chat-launch-draft-resolution'

function userMessage(id: string, text: string): NativeChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], timestamp: 1, source: 'transcript' }
}

describe('launchDraftResolvedByTranscript', () => {
  const SEEDED_AT = 100_000

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
