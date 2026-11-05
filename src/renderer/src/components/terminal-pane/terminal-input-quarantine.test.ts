import { describe, it, expect, beforeEach, vi } from 'vitest'

const { notifyTerminalInputNotSent } = vi.hoisted(() => ({ notifyTerminalInputNotSent: vi.fn() }))
vi.mock('./terminal-input-not-sent-notice', () => ({ notifyTerminalInputNotSent }))
import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine,
  isTerminalInputQuarantined,
  shouldDropQuarantinedTerminalInput
} from './terminal-input-quarantine'

const TAB = 'tab-1'
// Re-attach measured at ~1.1s in STA-2373 live QA; the tail lands just after.
const REATTACH_MS = 1_100

beforeEach(() => {
  _resetTerminalInputQuarantineForTests()
  notifyTerminalInputNotSent.mockReset()
})

describe('terminal input quarantine', () => {
  it('drops the surviving tail of an interrupted line and its Enter', () => {
    armTerminalInputQuarantine(TAB, 0)
    // The tail of `echo hi; rm -rf x` after the head was eaten by recovery.
    let at = REATTACH_MS
    for (const char of 'cho hi; rm -rf x') {
      expect(shouldDropQuarantinedTerminalInput(TAB, char, at)).toBe(true)
      at += 30
    }
    // The user's own Enter would have submitted the mangled line.
    expect(shouldDropQuarantinedTerminalInput(TAB, '\r', at)).toBe(true)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })

  it('releases on an idle gap once a quarantined byte has been seen', () => {
    armTerminalInputQuarantine(TAB, 0)
    // Burst tail, no Enter — the user was still mid-line when the endpoint died.
    expect(shouldDropQuarantinedTerminalInput(TAB, 'c', REATTACH_MS)).toBe(true)
    expect(shouldDropQuarantinedTerminalInput(TAB, 'h', REATTACH_MS + 40)).toBe(true)
    // Then they notice, pause, and type a real command.
    expect(shouldDropQuarantinedTerminalInput(TAB, 'l', REATTACH_MS + 40 + 700)).toBe(false)
    expect(isTerminalInputQuarantined(TAB)).toBe(false)
  })
})
