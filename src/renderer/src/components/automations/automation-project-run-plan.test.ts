import { describe, expect, it } from 'vitest'
import { normalizeAutomationCreateTargets } from './automation-project-run-plan'

describe('normalizeAutomationCreateTargets', () => {
  it('drops the primary and repeats from the extras', () => {
    expect(
      normalizeAutomationCreateTargets({
        projectId: 'a',
        extraProjectIds: ['b', 'a', 'b'],
        workspaceMode: 'existing'
      })
    ).toEqual({ extraProjectIds: ['b'], workspaceMode: 'new_per_run' })
  })

  it('keeps the chosen mode once no extra remains', () => {
    expect(
      normalizeAutomationCreateTargets({
        projectId: 'a',
        extraProjectIds: ['a'],
        workspaceMode: 'existing'
      })
    ).toEqual({ extraProjectIds: [], workspaceMode: 'existing' })
  })
})
