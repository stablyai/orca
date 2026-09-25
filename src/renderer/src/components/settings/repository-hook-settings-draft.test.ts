import { describe, expect, it } from 'vitest'
import {
  areHookSettingsDraftsEqual,
  getHookSettingsDraft,
  renderYamlScriptPreview
} from './repository-hook-settings-draft'

describe('repository hook settings draft', () => {
  it('normalizes persisted settings without dropping either script', () => {
    const draft = getHookSettingsDraft({
      mode: 'override',
      scripts: { setup: 'pnpm install', archive: '' }
    })

    expect(draft).toMatchObject({
      mode: 'override',
      setupRunPolicy: 'run-by-default',
      setupAgentStartupPolicy: 'start-immediately',
      scripts: { setup: 'pnpm install', archive: '' }
    })
  })

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

  it('renders the exact shared YAML projection', () => {
    expect(
      renderYamlScriptPreview({
        scripts: { setup: 'pnpm install\npnpm build', archive: 'pnpm clean' },
        issueCommand: 'Complete {{artifact_url}}'
      })
    ).toBe(
      'scripts:\n  setup: |\n    pnpm install\n    pnpm build\n  archive: |\n    pnpm clean\nissueCommand: |\n  Complete {{artifact_url}}'
    )
  })
})
