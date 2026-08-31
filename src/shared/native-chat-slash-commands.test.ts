import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
  mergeDiscoveredSlashCommands,
  slashCommandDispatchText
} from './native-chat-slash-commands'

describe('getAgentSlashCommands', () => {
  it('returns Codex-specific commands (e.g. /model, /resume) for codex', () => {
    const names = getAgentSlashCommands('codex').map((c) => c.name)
    expect(names).toContain('model')
    expect(names).toContain('resume')
    expect(names).toContain('diff')
  })

  it('returns Claude commands for claude (no Codex-only /model)', () => {
    const names = getAgentSlashCommands('claude').map((c) => c.name)
    expect(names).toContain('clear')
    expect(names).toContain('compact')
    expect(names).not.toContain('model')
  })

  it('falls back to a small common set for an unknown agent (never empty)', () => {
    const names = getAgentSlashCommands('some-other-agent').map((c) => c.name)
    expect(names).toEqual(['clear', 'help'])
  })
})

describe('isSlashCommandDraft', () => {
  it('is true for a leading slash, even with leading whitespace', () => {
    expect(isSlashCommandDraft('/clear')).toBe(true)
    expect(isSlashCommandDraft('  /model')).toBe(true)
  })

  it('is false for ordinary prose or a mid-line slash', () => {
    expect(isSlashCommandDraft('fix the bug')).toBe(false)
    expect(isSlashCommandDraft('run a/b test')).toBe(false)
    expect(isSlashCommandDraft('')).toBe(false)
  })
})

describe('filterSlashCommands', () => {
  const codex = getAgentSlashCommands('codex')

  it('returns all commands for an empty query (bare /)', () => {
    expect(filterSlashCommands(codex, '')).toHaveLength(codex.length)
  })

  it('prefix-matches case-insensitively', () => {
    const names = filterSlashCommands(codex, 'mod').map((c) => c.name)
    expect(names).toEqual(['model'])
    expect(filterSlashCommands(codex, 'MOD').map((c) => c.name)).toEqual(['model'])
  })
})

describe('dispatch vs completion text', () => {
  it('dispatch text has no trailing space (Enter dispatches the command)', () => {
    expect(slashCommandDispatchText({ name: 'clear' })).toBe('/clear')
  })

  it('completion text has a trailing space (Tab completes for arguments)', () => {
    expect(applySlashSuggestion({ name: 'model' })).toBe('/model ')
  })
})

describe('mergeDiscoveredSlashCommands', () => {
  const discovered = (name: string, description: string | null = null) => ({
    name,
    description,
    scope: 'project' as const,
    commandFilePath: `/repo/.claude/commands/${name}.md`
  })

  it('appends discovered commands to the curated catalog', () => {
    const merged = mergeDiscoveredSlashCommands(getAgentSlashCommands('claude'), [
      discovered('opsx:apply', 'Apply a change')
    ])
    expect(merged.map((command) => command.name)).toContain('opsx:apply')
    expect(merged.find((command) => command.name === 'opsx:apply')?.description).toBe(
      'Apply a change'
    )
  })

  it('keeps the built-in when a custom command shadows its name', () => {
    const merged = mergeDiscoveredSlashCommands(
      [{ name: 'review', description: 'Review the current changes' }],
      [discovered('review', 'Custom review')]
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].description).toBe('Review the current changes')
  })

  it('drops filesystem names that are not typeable as one slash token', () => {
    const merged = mergeDiscoveredSlashCommands([], [discovered('two words')])
    expect(merged).toHaveLength(0)
  })

  it('sanitizes author-controlled descriptions', () => {
    const merged = mergeDiscoveredSlashCommands([], [discovered('opsx:apply', 'a‮b')])
    expect(merged[0].description).toBe('ab')
  })

  it('returns the curated catalog untouched when nothing was discovered', () => {
    const builtins = getAgentSlashCommands('claude')
    expect(mergeDiscoveredSlashCommands(builtins, [])).toBe(builtins)
  })
})
