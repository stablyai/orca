import { describe, expect, it } from 'vitest'
import { validateAutomationListResponse } from './automation-list-response'
import type { AutomationListScopeSelector } from './automation-list-scope'

function response(overrides: Record<string, unknown> = {}) {
  return {
    automations: [{ id: 'a1' }, { id: 'a2' }],
    items: [
      { automationId: 'a1', selector: { kind: 'self' } },
      { automationId: 'a2', selector: { kind: 'self' } }
    ],
    orphanCount: 3,
    ...overrides
  }
}

describe('validateAutomationListResponse', () => {
  it('requires an SSH item to carry the requested generation', () => {
    const scope: AutomationListScopeSelector = {
      kind: 'ssh',
      targetId: 'ssh-1',
      expectedTargetGeneration: 4
    }
    const stale = validateAutomationListResponse(
      response({
        items: [
          { automationId: 'a1', selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 3 } },
          { automationId: 'a2', selector: { kind: 'ssh', targetId: 'ssh-1', targetGeneration: 4 } }
        ]
      }),
      scope
    )
    expect(stale.ok && stale.result.automations.map((entry) => entry.id)).toEqual(['a2'])
    expect(stale.ok && stale.invalidRows).toBe(1)
  })
})
