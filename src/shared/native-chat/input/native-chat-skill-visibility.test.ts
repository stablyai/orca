import { describe, expect, it } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../skills'
import { getNativeChatAgentProfile } from '../native-chat-agent-profiles'
import {
  deriveComposerAutocomplete,
  isSkillPickerTriggered
} from './native-chat-composer-autocomplete'
import { isNativeChatSkillForAgent, nativeChatSessionSkills } from './native-chat-skill-visibility'

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

  it('lists Antigravity folder skills when ACP reports only built-in commands', () => {
    const profile = getNativeChatAgentProfile('antigravity')
    expect(isSkillPickerTriggered('/', profile)).toBe(true)
    // ACP lists /model and /clear, not installed skills. A defined session list would hide the folder scan.
    expect(
      nativeChatSessionSkills('antigravity', [
        { name: 'model', kind: 'command' },
        { name: 'clear', kind: 'command' }
      ])
    ).toBeUndefined()

    const ownRoot = '/Users/test/.gemini/config/skills'
    const adr = skill({
      name: 'adr',
      rootPath: ownRoot,
      directoryPath: `${ownRoot}/adr`,
      skillFilePath: `${ownRoot}/adr/SKILL.md`
    })
    expect(isNativeChatSkillForAgent('antigravity', adr, discovery('antigravity', ownRoot))).toBe(
      true
    )
    expect(isNativeChatSkillForAgent('antigravity', skill({}), discovery(null))).toBe(true)
    expect(
      isNativeChatSkillForAgent(
        'antigravity',
        skill({ rootPath: '/Users/test/.claude/skills' }),
        discovery('claude', '/Users/test/.claude/skills')
      )
    ).toBe(false)
    // Gemini CLI's ~/.gemini/skills is a different agent. Antigravity links config/skills only.
    expect(
      isNativeChatSkillForAgent(
        'antigravity',
        skill({ rootPath: '/Users/test/.gemini/skills' }),
        discovery('gemini', '/Users/test/.gemini/skills')
      )
    ).toBe(false)

    const menu = deriveComposerAutocomplete('/', 1, [{ name: 'clear' }], [adr], profile)
    expect(menu.mode).toBe('slash')
    if (menu.mode !== 'slash') {
      return
    }
    expect(menu.items.filter((item) => item.kind === 'skill').map((item) => item.name)).toContain(
      'adr'
    )
  })
})
