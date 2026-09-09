import { describe, expect, it } from 'vitest'
import { discoveredSkillTokenName } from './native-chat-skill-visibility'
import type { DiscoveredSkill } from './skills'

function skill(fields: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'claude:quiver:catchup',
    name: 'catchup',
    description: 'Catch up',
    providers: ['claude'],
    sourceKind: 'plugin',
    sourceLabel: 'Claude plugin quiver',
    rootPath: '/home/u/.claude/plugins/cache/quiver/quiver/0.4.0/skills',
    directoryPath: '/home/u/.claude/plugins/cache/quiver/quiver/0.4.0/skills/catchup',
    skillFilePath: '/home/u/.claude/plugins/cache/quiver/quiver/0.4.0/skills/catchup/SKILL.md',
    installed: true,
    updatedAt: null,
    ...fields
  }
}

describe('discoveredSkillTokenName', () => {
  it('namespaces a plugin skill with the plugin the source label carries', () => {
    expect(discoveredSkillTokenName(skill({}))).toBe('quiver:catchup')
  })

  it('keeps non-plugin skills under their plain name', () => {
    expect(
      discoveredSkillTokenName(
        skill({
          id: 'claude:catchup',
          sourceKind: 'home',
          sourceLabel: 'Home',
          rootPath: '/home/u/.claude/skills',
          directoryPath: '/home/u/.claude/skills/catchup',
          skillFilePath: '/home/u/.claude/skills/catchup/SKILL.md'
        })
      )
    ).toBe('catchup')
  })

  it('falls back to the plain name when a plugin label carries no plugin name', () => {
    expect(discoveredSkillTokenName(skill({ sourceLabel: 'Claude plugin ' }))).toBe('catchup')
  })
})
