import { describe, expect, it } from 'vitest'
import { withAgentExitReceiptTime } from './terminal-side-effect-facts'

describe('a paired host exit fact on this client (R2-13)', () => {
  it("orders the exit by this client's receipt time, never the host's clock", () => {
    const facts = withAgentExitReceiptTime(
      [{ kind: 'agent-working' }, { kind: 'agent-exited', observedAtMs: 9_999_999 }],
      2_000
    )
    expect(facts).toEqual([
      { kind: 'agent-working' },
      { kind: 'agent-exited', observedAtMs: 2_000 }
    ])
  })
})
