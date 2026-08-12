import { describe, expect, it } from 'vitest'
import {
  applyMentionSuggestion,
  applyPickerSuggestion,
  applySlashSuggestion,
  buildNativeChatPickerItems,
  classifyNativeChatSend,
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
  EMPTY_HISTORY,
  filterSlashCommands,
  isSlashCommandDraft,
  pushHistory,
  recallNext,
  recallPrevious,
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
    fileCount: 1,
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

describe('deriveComposerAutocomplete — skill', () => {
  const skills = [
    skill({ name: 'typescript' }),
    skill({ name: 'react-useeffect', directoryPath: '/repo/.agents/skills/react-useeffect' })
  ]

  it('enters skill mode with the query after `$`', () => {
    const result = deriveComposerAutocomplete('use $type', 9, COMMANDS, skills)
    expect(result.mode).toBe('skill')
    if (result.mode !== 'skill') {
      return
    }
    expect(result.query).toBe('type')
    expect(result.items.map((entry) => entry.name)).toEqual(['typescript'])
  })

  it('fires at the start of input too', () => {
    expect(deriveComposerAutocomplete('$react', 6, COMMANDS, skills).mode).toBe('skill')
  })

  it('does not fire inside shell-style text', () => {
    expect(deriveComposerAutocomplete('price$tag', 9, COMMANDS, skills).mode).toBe('none')
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

describe('history recall', () => {
  it('up-arrow on empty composer recalls the last sent input', () => {
    const history = pushHistory(EMPTY_HISTORY, 'first')
    const recall = recallPrevious(history)
    expect(recall.draft).toBe('first')
    expect(recall.history.index).toBe(0)
  })

  it('walks backward and clamps at the oldest entry', () => {
    let history = pushHistory(EMPTY_HISTORY, 'a')
    history = pushHistory(history, 'b')
    const first = recallPrevious(history)
    expect(first.draft).toBe('b')
    const second = recallPrevious(first.history)
    expect(second.draft).toBe('a')
    const third = recallPrevious(second.history)
    expect(third.draft).toBe('a') // clamped
  })

  it('down-arrow walks forward and returns to a live empty draft', () => {
    let history = pushHistory(EMPTY_HISTORY, 'a')
    history = pushHistory(history, 'b')
    const up1 = recallPrevious(history) // 'b'
    const up2 = recallPrevious(up1.history) // 'a'
    const down = recallNext(up2.history) // 'b'
    expect(down.draft).toBe('b')
    const back = recallNext(down.history) // live
    expect(back.draft).toBe('')
    expect(back.history.index).toBeNull()
  })

  it('does not record blank sends or immediate duplicates', () => {
    let history = pushHistory(EMPTY_HISTORY, '   ')
    expect(history.entries).toHaveLength(0)
    history = pushHistory(history, 'x')
    history = pushHistory(history, 'x')
    expect(history.entries).toHaveLength(1)
  })

  it('recall on empty history is a no-op', () => {
    expect(recallPrevious(EMPTY_HISTORY).draft).toBeNull()
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
    expect(result.draft).toBe('open @src/app.ts  more')
    expect(result.caret).toBe('open @src/app.ts '.length)
  })

  it('applyPickerSuggestion replaces the active $token at the caret', () => {
    const result = applyPickerSuggestion(
      'use $typ now',
      8,
      { kind: 'skill', id: 'skill:typescript', name: 'typescript', description: null, sources: [] },
      '$'
    )
    expect(result.draft).toBe('use $typescript  now')
    expect(result.caret).toBe('use $typescript '.length)
  })
})

describe('native skill and command picker', () => {
  it('keeps Codex commands under slash and skills under dollar', () => {
    const profile = getNativeChatAgentProfile('codex')
    const slash = deriveComposerAutocomplete('/', 1, COMMANDS, [skill({})], profile)
    expect(slash.mode).toBe('slash')
    if (slash.mode === 'slash') {
      expect(slash.items.every((item) => item.kind === 'command')).toBe(true)
    }
    const dollar = deriveComposerAutocomplete('$', 1, COMMANDS, [skill({})], profile)
    expect(dollar.mode).toBe('skill')
    if (dollar.mode === 'skill') {
      expect(dollar.items.every((item) => item.kind === 'skill')).toBe(true)
    }
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

  it('ranks exact, prefix, fuzzy, then description matches within a group', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({ name: 'deploy', skillFilePath: '/1/SKILL.md' }),
        skill({ name: 'deployment', skillFilePath: '/2/SKILL.md' }),
        skill({ name: 'd-e-p-l-o-y', skillFilePath: '/3/SKILL.md' }),
        skill({
          name: 'release',
          description: 'Deploy an application',
          skillFilePath: '/4/SKILL.md'
        })
      ],
      'deploy',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual([
      'deploy',
      'deployment',
      'd-e-p-l-o-y',
      'release'
    ])
  })

  it('merges duplicate names but annotates command collisions on one command row', () => {
    const duplicateSkills = [
      skill({ name: 'clear', skillFilePath: '/project/clear/SKILL.md', sourceKind: 'repo' }),
      skill({ name: 'clear', skillFilePath: '/home/clear/SKILL.md', sourceKind: 'home' })
    ]
    const skillOnly = buildNativeChatPickerItems([], duplicateSkills, '', '$')
    expect(skillOnly).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'clear', sources: expect.any(Array) })
    ])
    expect(skillOnly[0].kind === 'skill' ? skillOnly[0].sources : []).toHaveLength(2)

    const collision = buildNativeChatPickerItems(COMMANDS, duplicateSkills, 'clear', '/')
    expect(collision).toEqual([
      expect.objectContaining({ kind: 'command', name: 'clear', skillCollision: true })
    ])
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
    const applied = applyPickerSuggestion('$sk', 3, items[0], '$')
    expect(applied.draft).toBe(`$${longName} `)
  })

  it('rejects names carrying zero-width characters instead of inserting them', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({
          name: 'cle\u200bar',
          directoryPath: '/repo/.agents/skills/safe-dir',
          skillFilePath: '/repo/.agents/skills/safe-dir/SKILL.md'
        })
      ],
      '',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual(['safe-dir'])
  })

  it('falls back to a token-safe directory name and strips unsafe display text', () => {
    const items = buildNativeChatPickerItems(
      [],
      [
        skill({
          name: 'Spoof\u202e Name',
          directoryPath: '/repo/.agents/skills/safe-name',
          skillFilePath: '/repo/.agents/skills/safe-name/SKILL.md'
        })
      ],
      '',
      '$'
    )
    expect(items.map((item) => item.name)).toEqual(['safe-name'])
  })

  it('replaces only the active slash token and preserves text after the caret', () => {
    const result = applyPickerSuggestion(
      '/bro trailing',
      4,
      { kind: 'skill', id: 'skill:browser', name: 'browser', description: null, sources: [] },
      '/'
    )
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
    expect(editReplacesTriggerToken('use $foo', 'use $bar', '$:4')).toBe(true)
  })

  it('keeps suppression while typing or deleting inside the dismissed token', () => {
    expect(editReplacesTriggerToken('/foo', '/food', '/:0')).toBe(false)
    expect(editReplacesTriggerToken('/food', '/foo', '/:0')).toBe(false)
    expect(editReplacesTriggerToken('use $foo now', 'ran $foo now', '$:4')).toBe(false)
  })

  it('suppresses only the dismissed trigger occurrence', () => {
    const profile = getNativeChatAgentProfile('codex')
    expect(deriveComposerAutocomplete('use $bro', 8, COMMANDS, [skill({})], profile).mode).toBe(
      'skill'
    )
    expect(
      deriveComposerAutocomplete(
        'use $bro',
        8,
        COMMANDS,
        [skill({})],
        profile,
        { status: 'ready', skills: [skill({})] },
        '$:4'
      ).mode
    ).toBe('none')
  })
})
