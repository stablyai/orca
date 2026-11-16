import { describe, expect, it } from 'vitest'
import {
  deriveComposerAutocomplete,
  isSkillPickerTriggered
} from './native-chat-composer-autocomplete'
import type { SlashCommandSuggestion } from '../commands/native-chat-slash-commands'

import type { DiscoveredSkill } from '../../../skills/discovery/skills'
import { getNativeChatAgentProfile } from '../commands/native-chat-agent-profiles'

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
