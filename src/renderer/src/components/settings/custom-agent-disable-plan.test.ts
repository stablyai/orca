import { describe, expect, it } from 'vitest'
import type { AgentReferenceSummary } from '../../../../shared/agent-reference-snapshot'
import { disableNeedsConfirmation, summarizeDisableReferences } from './custom-agent-disable-plan'

describe('summarizeDisableReferences', () => {
  it('sums every readable owner including the default reference', () => {
    const summary: AgentReferenceSummary[] = [
      { owner: 'default', count: 1 },
      { owner: 'quick-command', count: 2 }
    ]
    expect(summarizeDisableReferences(summary)).toEqual({ total: 3, unreadable: false })
  })

  it('treats a -1 owner as an unreadable floor', () => {
    expect(summarizeDisableReferences([{ owner: 'automation', count: -1 }])).toEqual({
      total: 0,
      unreadable: true
    })
  })
})

describe('disableNeedsConfirmation', () => {
  it('is immediate only when provably unreferenced', () => {
    expect(disableNeedsConfirmation([])).toBe(false)
    expect(disableNeedsConfirmation([{ owner: 'quick-command', count: 0 }])).toBe(false)
  })

  it('confirms when any readable reference exists', () => {
    expect(disableNeedsConfirmation([{ owner: 'quick-command', count: 1 }])).toBe(true)
  })

  it('confirms when an owner store is unreadable (cannot prove zero)', () => {
    expect(disableNeedsConfirmation([{ owner: 'session', count: -1 }])).toBe(true)
  })
})
