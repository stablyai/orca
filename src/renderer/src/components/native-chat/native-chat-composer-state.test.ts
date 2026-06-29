import { describe, expect, it } from 'vitest'
import {
  applyMentionSuggestion,
  applySkillSuggestion,
  applySlashSuggestion,
  deriveComposerAutocomplete,
  EMPTY_HISTORY,
  filterSkillSuggestions,
  filterSlashCommands,
  isSlashCommandDraft,
  pushHistory,
  recallNext,
  recallPrevious,
  slashCommandDispatchText,
  type SlashCommandSuggestion
} from './native-chat-composer-state'
import type { DiscoveredSkill } from '../../../../shared/skills'

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
    expect(result.suggestions.map((c) => c.name)).toEqual(['clear'])
  })

  it('a bare `/` returns the full command list', () => {
    const result = deriveComposerAutocomplete('/', 1, COMMANDS)
    expect(result.mode).toBe('slash')
    if (result.mode !== 'slash') {
      return
    }
    expect(result.suggestions).toHaveLength(3)
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
    expect(result.suggestions.map((entry) => entry.name)).toEqual(['typescript'])
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

describe('filterSkillSuggestions', () => {
  it('filters installed skills by name or directory basename', () => {
    const skills = [
      skill({ name: 'TypeScript' }),
      skill({ name: 'Display Name', directoryPath: '/repo/.agents/skills/ref-oss' }),
      skill({ name: 'hidden', installed: false })
    ]
    expect(filterSkillSuggestions(skills, 'ref').map((entry) => entry.name)).toEqual([
      'Display Name'
    ])
    expect(filterSkillSuggestions(skills, 'h')).toEqual([])
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

  it('applySkillSuggestion replaces the active $token at the caret', () => {
    const result = applySkillSuggestion('use $typ now', 8, 'typescript')
    expect(result.draft).toBe('use $typescript  now')
    expect(result.caret).toBe('use $typescript '.length)
  })
})
