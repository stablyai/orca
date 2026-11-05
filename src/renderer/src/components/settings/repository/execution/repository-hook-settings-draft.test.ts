import { describe, expect, it } from 'vitest'
import {
  areHookSettingsDraftsEqual,
  getHookSettingsDraft,
  renderYamlScriptPreview
} from './repository-hook-settings-draft'

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

  it('previews reviewCommand alongside issueCommand', () => {
    expect(
      renderYamlScriptPreview({
        scripts: { setup: 'echo hi' },
        issueCommand: 'Complete {{artifact_url}}',
        reviewCommand: 'Review {{artifact_url}}'
      })
    ).toContain('reviewCommand: |\n  Review {{artifact_url}}')
  })
})
