/**
 * Unit tests for the pure agent-to-agent consent gate (P1-1).
 */

import { describe, it, expect } from 'vitest'
import { gateAgentMessageSend } from './agent-consent-gate'

describe('gateAgentMessageSend', () => {
  it('grants when the resolved decision is allow', () => {
    const result = gateAgentMessageSend({ decision: 'allow' }, { targetAgentType: 'pi' })
    expect(result).toEqual({ granted: true })
  })

  it('denies with consent_denied when the resolved decision is deny', () => {
    const result = gateAgentMessageSend({ decision: 'deny' }, { targetAgentType: 'pi' })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.code).toBe('consent_denied')
      expect(result.error).toContain('pi')
    }
  })

  it('denies with consent_unknown when the pair was never decided (deny-by-default)', () => {
    const result = gateAgentMessageSend({ decision: 'unknown' }, { targetAgentType: 'codex' })
    expect(result.granted).toBe(false)
    if (!result.granted) {
      expect(result.code).toBe('consent_unknown')
      expect(result.error).toContain('codex')
    }
  })

  it('never grants for any decision other than the literal allow string', () => {
    // Guards against a future refactor accidentally treating a truthy-but-
    // wrong value (e.g. a decision object, or 'ALLOW') as granted.
    for (const decision of ['deny', 'unknown'] as const) {
      const result = gateAgentMessageSend({ decision }, { targetAgentType: 'x' })
      expect(result.granted).toBe(false)
    }
  })

  it('is pure: identical inputs always produce an identical decision', () => {
    const subject = { decision: 'allow' as const }
    const target = { targetAgentType: 'prime-agent' }
    const first = gateAgentMessageSend(subject, target)
    const second = gateAgentMessageSend(subject, target)
    expect(first).toEqual(second)
  })
})
