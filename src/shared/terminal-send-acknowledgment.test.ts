import { describe, expect, it } from 'vitest'
import { readTerminalSendAcknowledgment } from './terminal-send-acknowledgment'

describe('terminal send acknowledgment', () => {
  it('reads a settling reply as accepted and a refused one as refused', () => {
    expect(
      readTerminalSendAcknowledgment(
        { send: { accepted: true, writeSettlement: { outcome: 'accepted' } } },
        { requireSettlement: true }
      )
    ).toBe('accepted')
    expect(
      readTerminalSendAcknowledgment(
        { send: { accepted: false, writeSettlement: { outcome: 'refused' } } },
        { requireSettlement: true }
      )
    ).toBe('refused')
  })

  it('trusts the legacy whole-write verdict only when settlement is not required', () => {
    const legacy = { send: { accepted: true } }
    expect(readTerminalSendAcknowledgment(legacy)).toBe('accepted')
    expect(readTerminalSendAcknowledgment(legacy, { requireSettlement: true })).toBe('unverifiable')
  })
})
