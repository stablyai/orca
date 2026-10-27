import { describe, expect, it } from 'vitest'
import { areHookSettingsDraftsEqual, getHookSettingsDraft } from './repository-hook-settings-draft'

describe('repository hook settings draft', () => {
  it('includes every persisted field in dirty-draft equality', () => {
    const baseline = getHookSettingsDraft(undefined)
    expect(areHookSettingsDraftsEqual(baseline, { ...baseline })).toBe(true)
    expect(
      areHookSettingsDraftsEqual(baseline, {
        ...baseline,
        setupAgentStartupPolicy: 'wait-for-setup'
      })
    ).toBe(false)
    expect(
      areHookSettingsDraftsEqual(baseline, {
        ...baseline,
        scripts: { ...baseline.scripts, archive: 'cleanup' }
      })
    ).toBe(false)
  })
})
