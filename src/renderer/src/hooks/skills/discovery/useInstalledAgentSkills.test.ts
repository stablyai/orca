import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill } from '../../../../../shared/skills'
import { GLOBAL_AGENT_SKILL_SOURCE_KINDS, hasInstalledAgentSkill } from './useInstalledAgentSkills'

function makeSkill(
  overrides: Partial<DiscoveredSkill> & Pick<DiscoveredSkill, 'name'>
): DiscoveredSkill {
  return {
    id: overrides.name,
    description: '',
    sourceKind: 'home',
    sourceLabel: 'Claude',
    installed: true,
    updatedAt: null,
    providers: ['claude'],
    rootPath: '/Users/test/.claude/skills',
    directoryPath: `/Users/test/.claude/skills/${overrides.name}`,
    skillFilePath: `/Users/test/.claude/skills/${overrides.name}/SKILL.md`,
    ...overrides
  }
}

describe('hasInstalledAgentSkill synced-folder exclusion', () => {
  it('does not count Claude desktop synced skills as installs', () => {
    const synced = [
      makeSkill({
        name: 'computer-use',
        providers: ['claude'],
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/synced/org_bucket/computer-use'
      }),
      makeSkill({
        name: 'computer-use',
        providers: ['claude'],
        rootPath: 'C:\\Users\\test\\.claude\\skills',
        directoryPath: 'C:\\Users\\test\\.claude\\skills\\synced\\org_bucket\\computer-use'
      })
    ]
    expect(
      hasInstalledAgentSkill(synced, 'computer-use', {
        sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
      })
    ).toBe(false)
  })

  it('still counts synced folder installs outside Claude home', () => {
    const options = { sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS }
    for (const directoryPath of [
      '/Users/test/.hermes/skills/synced/computer-use',
      '/Users/test/.hermes/skills/synced/team/computer-use'
    ]) {
      const installed = makeSkill({
        name: 'computer-use',
        providers: ['codex'],
        rootPath: '/Users/test/.hermes/skills',
        directoryPath
      })
      expect(hasInstalledAgentSkill([installed], 'computer-use', options)).toBe(true)
    }
  })
})
