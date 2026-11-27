import { expect, it, vi } from 'vitest'
import type * as Sha256Module from '../../hashing/sha256'

const hashing = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../../hashing/sha256', async (load) => {
  const actual = await load<typeof Sha256Module>()
  return {
    sha256: (message: Uint8Array) => {
      hashing.calls += 1
      return actual.sha256(message)
    }
  }
})

const { structuredAgentSessionPaneKey } = await import('./structured-agent-session-projection')

// Perf contract: a 2,604-chat pass missed every time against a 2,048-entry FIFO, so each
// orchestration rebuild re-hashed every live session. A repeat pass over 26,000 chats hashes nothing.
it('does not re-hash live sessions on a repeat pass at N and 10N chats', () => {
  for (const chatCount of [2_604, 26_040]) {
    const sessions = Array.from({ length: chatCount }, (_, index) => `s-${chatCount}-${index}`)
    for (const sessionId of sessions) {
      structuredAgentSessionPaneKey(`tab-${sessionId}`, sessionId)
    }
    const before = hashing.calls
    for (const sessionId of sessions) {
      structuredAgentSessionPaneKey(`tab-${sessionId}`, sessionId)
    }
    expect(hashing.calls - before).toBe(0)
  }
})
