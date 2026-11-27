import { describe, expect, it } from 'vitest'
import { claimTerminalHandoffInterrupt } from './terminal-handoff-interrupt-claim'

describe('claimTerminalHandoffInterrupt', () => {
  it('admits only one competing handoff interrupt for a terminal turn', () => {
    const transport = { getPtyId: () => 'original-pty' }
    const turn = { ptyId: 'original-pty', startedAt: 100 }
    expect(claimTerminalHandoffInterrupt(transport, turn)).toBe(true)
    expect(claimTerminalHandoffInterrupt(transport, { ...turn })).toBe(false)
    expect(claimTerminalHandoffInterrupt(transport, { ...turn, startedAt: 200 })).toBe(true)
  })
})
