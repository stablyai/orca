import { describe, expect, it } from 'vitest'
import {
  applyMentionSuggestion,
  applyPickerSuggestion,
  applySlashSuggestion,
  buildNativeChatPickerItems,
  classifyNativeChatSend,
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
  filterSlashCommands,
  isSkillPickerTriggered,
  isSlashCommandDraft,
  slashCommandDispatchText,
  type SlashCommandSuggestion
} from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'

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

describe('deriveComposerAutocomplete — slash', () => {
  it('enters slash mode for `/` at the start and filters by query', () => {
    const result = deriveComposerAutocomplete('/cl', 3, COMMANDS)
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.query).toBe('cl')
    expect(result.items.map((item) => item.name)).toEqual(['clear'])
  })

  it('a bare `/` returns the full command list', () => {
    const result = deriveComposerAutocomplete('/', 1, COMMANDS)
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items).toHaveLength(3)
  })

  it('does not fire slash mode after a space', () => {
    expect(deriveComposerAutocomplete('/clear now', 10, COMMANDS).mode).toBe('none')
  })

  it('does not fire slash mode mid-line', () => {
    expect(deriveComposerAutocomplete('hi /clear', 9, COMMANDS).mode).toBe('none')
  })
})

describe('deriveComposerAutocomplete — mention', () => {
  it('enters mention mode with the query after `@`', () => {
    const result = deriveComposerAutocomplete('look at @src/ind', 16, COMMANDS)
    expect(result.mode).toBe('mention')
    if (result.mode !== 'mention') {
      return
    }
    expect(result.query).toBe('src/ind')
  })

  it('stays closed for a dismissed `@` token until a new one starts', () => {
    const closed = deriveComposerAutocomplete('a @foo', 6, COMMANDS, [], null, undefined, '@:2')
    expect(closed.mode).toBe('none')
    const next = deriveComposerAutocomplete('a @foo @b', 9, COMMANDS, [], null, undefined, '@:2')
    expect(next.mode).toBe('mention')
  })

  it('fires at the start of input too', () => {
    const result = deriveComposerAutocomplete('@foo', 4, COMMANDS)
    expect(result.mode).toBe('mention')
    if (result.mode !== 'mention') {
      return
    }
    expect(result.query).toBe('foo')
  })

  it('does not fire for an email-like `@` (no preceding whitespace)', () => {
    expect(deriveComposerAutocomplete('me@example', 10, COMMANDS).mode).toBe('none')
  })
})

describe('deriveComposerAutocomplete — one grammar for every agent', () => {
  const skills = [
    skill({ name: 'typescript' }),
    skill({ name: 'react-useeffect', directoryPath: '/repo/.agents/skills/react-useeffect' })
  ]
  const codex = getNativeChatAgentProfile('codex')

  it('offers Codex skills under `/`, tokenised as the form Codex invokes', () => {
    const result = deriveComposerAutocomplete('use /type', 9, COMMANDS, skills, codex)
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.query).toBe('type')
    expect(result.items.map((entry) => entry.token)).toEqual(['$typescript'])
  })

  it('no longer treats `$` as a composer trigger', () => {
    expect(deriveComposerAutocomplete('use $type', 9, COMMANDS, skills, codex).mode).toBe('none')
    expect(deriveComposerAutocomplete('$react', 6, COMMANDS, skills, codex).mode).toBe('none')
  })

  it('does not fire inside shell-style text', () => {
    expect(deriveComposerAutocomplete('price$tag', 9, COMMANDS, skills, codex).mode).toBe('none')
  })
})

describe('filterSlashCommands', () => {
  it('is case-insensitive prefix match', () => {
    expect(filterSlashCommands(COMMANDS, 'C').map((c) => c.name)).toEqual(['clear', 'compact'])
  })
})

describe('isSlashCommandDraft', () => {
  it('treats leading slash drafts as TUI commands, not chat prompts', () => {
    expect(isSlashCommandDraft('/clear')).toBe(true)
    expect(isSlashCommandDraft('  /compact')).toBe(true)
    expect(isSlashCommandDraft('please run /clear')).toBe(false)
  })
})

describe('apply suggestions', () => {
  it('applySlashSuggestion replaces the token with a trailing space', () => {
    expect(applySlashSuggestion({ name: 'clear' })).toBe('/clear ')
  })

  it('slashCommandDispatchText returns the command without completion whitespace', () => {
    expect(slashCommandDispatchText({ name: 'clear' })).toBe('/clear')
  })

  it('applyMentionSuggestion replaces the active @token at the caret', () => {
    const result = applyMentionSuggestion('open @sr more', 8, 'src/app.ts')
    expect(result.draft).toBe('open @src/app.ts more')
    expect(result.caret).toBe('open @src/app.ts '.length)
  })

  it('applyMentionSuggestion quotes a path the agent would otherwise split', () => {
    const result = applyMentionSuggestion('@my', 3, 'docs/my notes.md')
    expect(result.draft).toBe('@"docs/my notes.md" ')
  })

  it('applyPickerSuggestion swaps the typed /token for the agent-native token', () => {
    const result = applyPickerSuggestion('use /typ now', 8, {
      kind: 'skill',
      id: 'skill:typescript',
      name: 'typescript',
      token: '$typescript',
      description: null,
      sources: []
    })
    expect(result.draft).toBe('use $typescript  now')
    expect(result.caret).toBe('use $typescript '.length)
    expect(result.insertedToken).toBe('$typescript')
  })
})

describe('native skill and command picker', () => {
  it('puts Codex commands and skills in one `/` menu, each with its own token', () => {
    const slash = deriveComposerAutocomplete(
      '/',
      1,
      COMMANDS,
      [skill({ name: 'browser' })],
      getNativeChatAgentProfile('codex')
    )
    expect(slash.mode).toBe('slash')
    if (slash.mode !== 'slash') {
      return
    }
    expect(slash.grouped).toBe(true)
    expect(slash.items.filter((item) => item.kind === 'command').map((item) => item.token)).toEqual(
      ['/clear', '/compact', '/help']
    )
    expect(slash.items.filter((item) => item.kind === 'skill').map((item) => item.token)).toEqual([
      '$browser'
    ])
  })

  it('keeps a Codex command and a same-named skill as separate rows', () => {
    const result = deriveComposerAutocomplete(
      '/clear',
      6,
      COMMANDS,
      [skill({ name: 'clear' })],
      getNativeChatAgentProfile('codex')
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.items.map((item) => item.token)).toEqual(['/clear', '$clear'])
    expect(result.items.find((item) => item.kind === 'command')?.skillCollision).toBe(false)
  })

  it('offers the same commands and skills for a `/` typed mid-prompt as for a leading one', () => {
    const args = [
      COMMANDS,
      [skill({ name: 'electron' })],
      getNativeChatAgentProfile('claude')
    ] as const
    const leading = deriveComposerAutocomplete('/', 1, ...args)
    const midPrompt = deriveComposerAutocomplete('validate it with /', 18, ...args)
    expect(midPrompt.mode).toBe('slash')
    if (midPrompt.mode !== 'slash' || leading.mode !== 'slash') {
      return
    }
    expect(midPrompt.items).toEqual(leading.items)
    expect(midPrompt.items.map((item) => item.kind)).toContain('command')
    expect(midPrompt.items.map((item) => item.kind)).toContain('skill')
    expect(midPrompt.grouped).toBe(leading.grouped)
  })

  it('filters the mid-prompt `/` menu by the typed token', () => {
    const result = deriveComposerAutocomplete(
      'validate it with /elec',
      22,
      COMMANDS,
      [skill({ name: 'electron' })],
      getNativeChatAgentProfile('claude')
    )
    expect(result.mode).toBe('slash')
    if (result.mode === 'slash') {
      expect(result.prefix).toBe('/')
      expect(result.items.map((item) => item.name)).toEqual(['electron'])
    }
  })

  it('marks only a draft-leading `/command` dispatchable', () => {
    const profile = getNativeChatAgentProfile('claude')
    const leading = deriveComposerAutocomplete('/comp', 5, COMMANDS, [], profile)
    const midPrompt = deriveComposerAutocomplete('then /comp', 10, COMMANDS, [], profile)
    expect(leading.mode === 'slash' && leading.dispatchable).toBe(true)
    expect(midPrompt.mode === 'slash' && midPrompt.dispatchable).toBe(false)
  })

  it('leaves a mid-prompt path alone', () => {
    expect(
      deriveComposerAutocomplete(
        'open /Users/me/notes',
        20,
        COMMANDS,
        [skill({ name: 'electron' })],
        getNativeChatAgentProfile('claude')
      ).mode
    ).toBe('none')
  })

  it('opens the mid-prompt `/` menu for Codex too, tokenised for Codex', () => {
    const result = deriveComposerAutocomplete(
      'validate it with /elec',
      22,
      COMMANDS,
      [skill({ name: 'electron' })],
      getNativeChatAgentProfile('codex')
    )
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.dispatchable).toBe(false)
    expect(result.items.map((item) => item.token)).toEqual(['$electron'])
  })

  it.each(['claude', 'codex'] as const)(
    'loads the skill catalog for both `/` trigger positions on %s',
    (agent) => {
      const profile = getNativeChatAgentProfile(agent)
      expect(isSkillPickerTriggered('/elec', profile)).toBe(true)
      expect(isSkillPickerTriggered('validate it with /elec', profile)).toBe(true)
      expect(isSkillPickerTriggered('open /Users/me', profile)).toBe(false)
      // Without a catalog fetch the menu would sit on a permanent loading row.
      expect(isSkillPickerTriggered('use $elec', profile)).toBe(false)
    }
  )

  it('applyPickerSuggestion replaces a mid-prompt /token at the caret', () => {
    const result = applyPickerSuggestion('validate it with /elec now', 22, {
      kind: 'skill',
      id: 'skill:electron',
      name: 'electron',
      token: '/electron',
      description: null,
      sources: []
    })
    expect(result.draft).toBe('validate it with /electron  now')
    expect(result.caret).toBe('validate it with /electron '.length)
  })

  it('groups Claude commands and skills under slash', () => {
    const result = deriveComposerAutocomplete(
      '/',
      1,
      COMMANDS,
      [skill({ name: 'browser' })],
      getNativeChatAgentProfile('claude')
    )
    expect(result.mode).toBe('slash')
    if (result.mode === 'slash') {
      expect(result.grouped).toBe(true)
      expect(result.items.map((item) => item.kind)).toContain('command')
      expect(result.items.map((item) => item.kind)).toContain('skill')
    }
  })

  it('keeps a long token-safe name intact for insertion instead of truncating it', () => {
    const longName = `skill-${'x'.repeat(100)}`
    const items = buildNativeChatPickerItems(
      [],
      [skill({ name: longName, skillFilePath: '/long/SKILL.md' })],
      '',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual([longName])
    const applied = applyPickerSuggestion('/sk', 3, items[0])
    expect(applied.draft).toBe(`$${longName} `)
  })

  it('replaces only the active slash token and preserves text after the caret', () => {
    const result = applyPickerSuggestion('/bro trailing', 4, {
      kind: 'skill',
      id: 'skill:browser',
      name: 'browser',
      token: '/browser',
      description: null,
      sources: []
    })
    expect(result.draft).toBe('/browser  trailing')
    expect(result.caret).toBe('/browser '.length)
  })

  it('classifies sends only from the origin tag and exact command catalog', () => {
    expect(classifyNativeChatSend('/browser do work', COMMANDS, '/browser', '/')).toBe('chat')
    expect(classifyNativeChatSend('/clear', COMMANDS, null, '/')).toBe('command')
    expect(classifyNativeChatSend('/Clear', COMMANDS, null, '/')).toBe('unknown-token')
    expect(classifyNativeChatSend('/usr/bin/python is missing', COMMANDS, null, '/')).toBe(
      'unknown-token'
    )
    expect(classifyNativeChatSend('ordinary prompt', COMMANDS, null, '/')).toBe('chat')
  })

  it('leading whitespace makes a slash draft prose, never a dispatched command', () => {
    expect(classifyNativeChatSend(' /clear', COMMANDS, null, '/')).toBe('chat')
  })

  it('treats a leading $ token as unknown only for the $-prefix (Codex) profile', () => {
    expect(classifyNativeChatSend('$deploy now', COMMANDS, null, '$')).toBe('unknown-token')
    expect(classifyNativeChatSend('$PATH is wrong', COMMANDS, null, '/')).toBe('chat')
    expect(classifyNativeChatSend('$50 is the budget', COMMANDS, null, null)).toBe('chat')
  })

  it('treats a one-edit token swap as a new trigger occurrence', () => {
    expect(editReplacesTriggerToken('/foo', '/bar', '/:0')).toBe(true)
    expect(editReplacesTriggerToken('use /foo', 'use /bar', '/:4')).toBe(true)
  })

  it('keeps suppression while typing or deleting inside the dismissed token', () => {
    expect(editReplacesTriggerToken('/foo', '/food', '/:0')).toBe(false)
    expect(editReplacesTriggerToken('/food', '/foo', '/:0')).toBe(false)
    expect(editReplacesTriggerToken('use /foo now', 'ran /foo now', '/:4')).toBe(false)
  })

  it('suppresses only the dismissed trigger occurrence', () => {
    const profile = getNativeChatAgentProfile('codex')
    expect(deriveComposerAutocomplete('use /bro', 8, COMMANDS, [skill({})], profile).mode).toBe(
      'slash'
    )
    expect(
      deriveComposerAutocomplete(
        'use /bro',
        8,
        COMMANDS,
        [skill({})],
        profile,
        { status: 'ready', skills: [skill({})] },
        '/:4'
      ).mode
    ).toBe('none')
  })
})
