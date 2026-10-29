import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from './skills'
import {
  discoveredSkillPlugin,
  discoveredSkillTokenName,
  isNativeChatSkillForAgent,
  pluginNamespacedSkillName
} from './native-chat-skill-visibility'

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: overrides.name ?? 'skill',
    name: 'agent-browser',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/agent-browser',
    skillFilePath: '/Users/test/.agents/skills/agent-browser/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

function discovery(owner: string | null, rootPath = '/Users/test/.agents/skills') {
  return {
    sources: [
      {
        id: 'source',
        label: 'Source',
        path: rootPath,
        sourceKind: 'home' as const,
        providers: ['agent-skills' as const],
        owner,
        exists: true
      }
    ]
  } satisfies Pick<SkillDiscoveryResult, 'sources'>
}

function pluginSkill(fields: Partial<DiscoveredSkill>): DiscoveredSkill {
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
    expect(discoveredSkillTokenName(pluginSkill({}))).toBe('quiver:catchup')
  })

  it('prefers the structured plugin field over parsing the display label', () => {
    expect(discoveredSkillTokenName(pluginSkill({ plugin: 'qv' }))).toBe('qv:catchup')
    expect(discoveredSkillPlugin(pluginSkill({ plugin: 'qv' }))).toBe('qv')
  })

  it('keeps non-plugin skills under their plain name', () => {
    expect(
      discoveredSkillTokenName(
        pluginSkill({
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
    expect(discoveredSkillTokenName(pluginSkill({ sourceLabel: 'Claude plugin ' }))).toBe('catchup')
    expect(pluginNamespacedSkillName(pluginSkill({ sourceLabel: 'Claude plugin ' }), 'safe')).toBe(
      'safe'
    )
  })
})

describe('isNativeChatSkillForAgent', () => {
  it('shows OpenCode the Claude skill folders it reads, and not Claude plugins', () => {
    const claude = discovery('claude')
    expect(isNativeChatSkillForAgent('opencode', skill({}), claude)).toBe(true)
    expect(isNativeChatSkillForAgent('opencode2', skill({}), claude)).toBe(true)
    const plugin = { sources: [{ ...claude.sources[0], sourceKind: 'plugin' as const }] }
    expect(isNativeChatSkillForAgent('opencode2', skill({}), plugin)).toBe(false)
  })

  it('grants visibility through any contributing root, not just the dedup survivor', () => {
    const result = {
      sources: [
        {
          id: 'codex-home',
          label: 'Codex home',
          path: '/Users/test/.codex/skills',
          sourceKind: 'home' as const,
          providers: ['codex' as const],
          owner: 'codex',
          exists: true
        },
        {
          id: 'shared-home',
          label: 'Agent skills home',
          path: '/Users/test/.agents/skills',
          sourceKind: 'home' as const,
          providers: ['agent-skills' as const],
          owner: null,
          exists: true
        }
      ]
    } satisfies Pick<SkillDiscoveryResult, 'sources'>
    // Canonical dedup may list the Codex root first; shared-root reachability must still grant other agents visibility.
    const merged = skill({
      rootPath: '/Users/test/.codex/skills',
      rootPaths: ['/Users/test/.codex/skills', '/Users/test/.agents/skills']
    })
    expect(isNativeChatSkillForAgent('claude', merged, result)).toBe(true)
    expect(isNativeChatSkillForAgent('codex', merged, result)).toBe(true)
    const codexOnly = skill({
      rootPath: '/Users/test/.codex/skills',
      rootPaths: ['/Users/test/.codex/skills']
    })
    expect(isNativeChatSkillForAgent('claude', codexOnly, result)).toBe(false)
  })
})
