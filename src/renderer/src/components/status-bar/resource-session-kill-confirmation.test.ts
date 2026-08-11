import { describe, expect, it } from 'vitest'
import { requiresKillConfirmation } from './resource-session-kill-confirmation'
import type { UnifiedSessionRow } from './resource-usage-merge-types'

function row(overrides: Partial<UnifiedSessionRow> = {}): UnifiedSessionRow {
  return {
    sessionId: 'sess-1',
    paneKey: null,
    pid: 0,
    label: 'zsh',
    bound: false,
    agentOwnership: 'absent',
    tabId: null,
    cpu: null,
    memory: null,
    hasLocalSamples: false,
    ...overrides
  }
}

describe('resource session kill confirmation', () => {
  it('confirms before killing a session with a visible tab', () => {
    expect(requiresKillConfirmation(row({ bound: true, tabId: 'tab-1' }))).toBe(true)
  })

  it('confirms before killing an agent-owned session that has no binding', () => {
    expect(requiresKillConfirmation(row({ bound: false, agentOwnership: 'present' }))).toBe(true)
  })

  it('confirms when ownership could not be established at all', () => {
    // Why: a provider that cannot serialize claims reports no owners for a session that may have
    // one. Treating that silence as proof of absence is the #8459 defect.
    expect(requiresKillConfirmation(row({ bound: false, agentOwnership: 'unknown' }))).toBe(true)
  })

  it('skips the prompt only on proven absence with no binding', () => {
    expect(requiresKillConfirmation(row())).toBe(false)
  })
})
