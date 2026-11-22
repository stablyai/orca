import { describe, expect, it } from 'vitest'
import { groupSkillInstallProviders } from './skill-install-provider-groups'

describe('groupSkillInstallProviders', () => {
  it('treats Gemini as a canonical global install and leaves Antigravity selectable', () => {
    const groups = groupSkillInstallProviders('global')
    expect(groups.canonical.map((provider) => provider.id)).toContain('gemini')
    expect(groups.selectable.find((choice) => choice.provider.id === 'gemini')).toBeUndefined()
    expect(groups.selectable.find((choice) => choice.provider.id === 'cursor')?.directory).toBe(
      '~/.cursor/skills'
    )
    expect(
      groups.selectable.find((choice) => choice.provider.id === 'antigravity')?.directory
    ).toBe('~/.gemini/config/skills')
  })
})
