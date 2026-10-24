import { describe, expect, it } from 'vitest'
import {
  discoveredSkillPlugin,
  discoveredSkillTokenName,
  isNativeChatSkillForAgent,
  pluginNamespacedSkillName
} from './native-chat-skill-visibility'
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

  it('prefers the structured plugin field over parsing the display label', () => {
    expect(discoveredSkillTokenName(skill({ plugin: 'qv' }))).toBe('qv:catchup')
    expect(discoveredSkillPlugin(skill({ plugin: 'qv' }))).toBe('qv')
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
    expect(pluginNamespacedSkillName(skill({ sourceLabel: 'Claude plugin ' }), 'safe')).toBe('safe')
  })
})

describe('isNativeChatSkillForAgent', () => {
  const home = skill({
    id: 'claude:catchup',
    sourceKind: 'home',
    sourceLabel: 'Home',
    rootPath: '/home/u/.claude/skills',
    directoryPath: '/home/u/.claude/skills/catchup',
    skillFilePath: '/home/u/.claude/skills/catchup/SKILL.md'
  })

  it('offers a shared-root skill to the agent that owns the root', () => {
    expect(
      isNativeChatSkillForAgent('claude', home, {
        sources: [
          {
            id: 's1',
            label: 'Home',
            path: '/home/u/.claude/skills',
            sourceKind: 'home',
            providers: ['claude'],
            owner: 'claude',
            exists: true
          }
        ]
      })
    ).toBe(true)
  })

  it('hides a skill whose every root belongs to another agent', () => {
    expect(
      isNativeChatSkillForAgent('codex', home, {
        sources: [
          {
            id: 's1',
            label: 'Home',
            path: '/home/u/.claude/skills',
            sourceKind: 'home',
            providers: ['claude'],
            owner: 'claude',
            exists: true
          }
        ]
      })
    ).toBe(false)
  })

  it('grants visibility through any of a symlinked skill several roots', () => {
    expect(
      isNativeChatSkillForAgent(
        'claude',
        skill({
          rootPath: '/repo/.claude/skills',
          rootPaths: ['/repo/.claude/skills', '/home/u/.claude/skills'],
          directoryPath: '/repo/.claude/skills/catchup',
          skillFilePath: '/repo/.claude/skills/catchup/SKILL.md'
        }),
        {
          sources: [
            {
              id: 's1',
              label: 'Repo',
              path: '/repo/.claude/skills',
              sourceKind: 'repo',
              providers: ['claude'],
              owner: 'codex',
              exists: true
            },
            {
              id: 's2',
              label: 'Home',
              path: '/home/u/.claude/skills',
              sourceKind: 'home',
              providers: ['claude'],
              owner: 'claude',
              exists: true
            }
          ]
        }
      )
    ).toBe(true)
  })
})
