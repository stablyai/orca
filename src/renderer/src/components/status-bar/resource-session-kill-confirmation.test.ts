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
  it('confirms when ownership could not be established at all', () => {
    // Missing serialized claims cannot prove a session has no agent owner.
    expect(requiresKillConfirmation(row({ bound: false, agentOwnership: 'unknown' }))).toBe(true)
  })
})
