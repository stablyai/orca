import { describe, expect, it } from 'vitest'
import { estimateZotzAgentMemory, recordZotzAgentPeak } from './zotz-agent-memory-ledger'

describe('zotz agent memory ledger', () => {
  it('estimates the p90 of the last 20 peaks and the default without history', () => {
    let ledger = {}
    expect(estimateZotzAgentMemory(ledger, 'codex', 2500)).toBe(2500)
    // 25 runs of 1..25: only 6..25 are kept, and the p90 (18th of 20) is 23.
    for (let peak = 1; peak <= 25; peak++) {
      ledger = recordZotzAgentPeak(ledger, 'codex', peak)
    }
    expect(estimateZotzAgentMemory(ledger, 'codex', 2500)).toBe(23)
    expect(estimateZotzAgentMemory(ledger, 'claude', 2500)).toBe(2500)
  })
})
