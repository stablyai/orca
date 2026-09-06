import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
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

  it.each([
    ['opencode', ['new', 'editor', 'exit']],
    ['kimi', ['compact', 'model', 'sessions']],
    ['pi', ['settings', 'tree', 'quit']],
    ['grok', ['workflows', 'session-info', 'help']]
  ] as const)('returns curated commands for %s', (agent, expected) => {
    const names = getAgentSlashCommands(agent).map((command) => command.name)
    for (const command of expected) {
      expect(names).toContain(command)
    }
  })

  it('keeps the main agent terminals on non-empty, duplicate-free command catalogs', () => {
    for (const agent of ['claude', 'codex', 'opencode', 'kimi', 'pi', 'grok'] as const) {
      const names = getAgentSlashCommands(agent).map((command) => command.name)
      expect(names.length).toBeGreaterThan(0)
      expect(new Set(names).size).toBe(names.length)
    }
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
