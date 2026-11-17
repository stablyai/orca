import { describe, expect, it } from 'vitest'
import {
  deriveComposerAutocomplete,
  isSkillPickerTriggered
} from './native-chat-composer-autocomplete'
import type { SlashCommandSuggestion } from '../commands/native-chat-slash-commands'

import type { DiscoveredSkill } from '../../../skills/discovery/skills'
import { getNativeChatAgentProfile } from '../commands/native-chat-agent-profiles'
import { buildNativeChatPickerItems } from './native-chat-picker-items'

const COMMANDS: SlashCommandSuggestion[] = [
  { name: 'clear' },
  { name: 'compact' },
  { name: 'help' }
]

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: overrides.name ?? 'skill',
    name: 'typescript',
    description: null,
    providers: ['codex'],
    sourceKind: 'repo',
    sourceLabel: 'Repository',
    rootPath: '/repo/.agents/skills',
    directoryPath: '/repo/.agents/skills/typescript',
    skillFilePath: '/repo/.agents/skills/typescript/SKILL.md',
    installed: true,
    updatedAt: null,
    ...overrides
  }
}

describe('deriveComposerAutocomplete — one grammar for every agent', () => {
  const skills = [
    skill({ name: 'typescript' }),
    skill({ name: 'react-useeffect', directoryPath: '/repo/.agents/skills/react-useeffect' })
  ]
  const codex = getNativeChatAgentProfile('codex')

  // `echo $HOME` + Enter once swapped `$HOME` for a skill whose description named $CODEX_HOME.
  it.each(['echo $HOME', 'costs $5', 'run $(pwd)'])('leaves shell `$` in %j as prose', (draft) => {
    expect(isSkillPickerTriggered(draft, codex)).toBe(false)
    expect(deriveComposerAutocomplete(draft, draft.length, COMMANDS, skills, codex).mode).toBe(
      'none'
    )
  })

  // Before Claude's init classifies its catalog, a plugin skill arrives as an unclassified `fwx:discuss`.
  it('picks a scanned Claude plugin skill under its plugin namespace', () => {
    const draft = '/fwx:di'
    const pluginSkill = skill({
      name: 'Discuss',
      providers: ['claude'],
      sourceKind: 'plugin',
      pluginName: 'fwx',
      directoryPath: '/cache/fwx/1.0.0/skills/discuss',
      skillFilePath: '/cache/fwx/1.0.0/skills/discuss/SKILL.md'
    })
    const result = deriveComposerAutocomplete(
      draft,
      draft.length,
      [{ name: 'fwx:discuss', kindUnspecified: true }],
      [pluginSkill],
      getNativeChatAgentProfile('claude')
    )

    expect(result.mode === 'slash' && result.items).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'fwx:discuss', token: '/fwx:discuss' })
    ])
  })
})

function repoSkills(count: number, prefix = 'repo-skill'): DiscoveredSkill[] {
  return Array.from({ length: count }, (_, index) =>
    skill({
      name: `${prefix}-${String(index).padStart(3, '0')}`,
      skillFilePath: `/repo/.agents/skills/${prefix}-${index}/SKILL.md`
    })
  )
}

describe('skill picker scope retention', () => {
  it('shows personal and plugin skills after a large project catalog in the bare slash menu', () => {
    const skills = [
      ...repoSkills(61),
      skill({ name: 'personal', sourceKind: 'home', skillFilePath: '/home/personal/SKILL.md' }),
      skill({ name: 'plugin', sourceKind: 'plugin', skillFilePath: '/cache/plugin/SKILL.md' })
    ]
    const result = deriveComposerAutocomplete(
      '/',
      1,
      COMMANDS,
      skills,
      getNativeChatAgentProfile('claude')
    )
    expect(result.mode === 'slash' && result.items.slice(-3).map((item) => item.token)).toEqual([
      '/repo-skill-060',
      '/personal',
      '/plugin'
    ])
  })

  it('retains smaller and unlocated reported scopes when the safety cap binds', () => {
    const skills = [
      ...repoSkills(800),
      skill({ name: 'personal', sourceKind: 'home', skillFilePath: '/home/personal/SKILL.md' }),
      skill({ name: 'plugin', sourceKind: 'plugin', skillFilePath: '/cache/plugin/SKILL.md' }),
      skill({ name: 'not-loaded', sourceKind: 'bundled', skillFilePath: '/bundle/absent/SKILL.md' })
    ]
    const sessionSkills = [
      ...skills
        .filter((item) => item.name !== 'not-loaded')
        .map((item) => ({
          name: item.name,
          path: item.skillFilePath
        })),
      { name: 'reported-only' }
    ]
    const items = buildNativeChatPickerItems([], skills, '', '/', sessionSkills)
    expect(items).toHaveLength(500)
    expect(items.slice(-4).map((item) => item.name)).toEqual([
      'repo-skill-496',
      'personal',
      'plugin',
      'reported-only'
    ])
    expect(items.some((item) => item.name === 'not-loaded')).toBe(false)
    expect(items.find((item) => item.name === 'personal')).toMatchObject({
      path: '/home/personal/SKILL.md',
      token: '/personal'
    })
    expect(buildNativeChatPickerItems([], skills, '', '/', [])).toEqual([])
  })

  it('keeps search relevance ahead of scope fairness', () => {
    const skills = [
      ...repoSkills(600, 'deploy'),
      skill({ name: 'alpha-deploy', sourceKind: 'home', skillFilePath: '/home/deploy/SKILL.md' })
    ]
    const items = buildNativeChatPickerItems([], skills, 'deploy', '/')
    expect(items).toHaveLength(500)
    expect(items[0].name).toBe('deploy-000')
    expect(items[499].name).toBe('deploy-499')
    expect(items.some((item) => item.name === 'alpha-deploy')).toBe(false)
  })

  it('keeps the unlimited catalog used by mobile skill token recognition', () => {
    const items = buildNativeChatPickerItems([], repoSkills(601), '', '$', undefined, Infinity)
    expect(items).toHaveLength(601)
    expect(items[600].token).toBe('$repo-skill-600')
  })
})
