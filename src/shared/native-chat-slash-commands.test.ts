import { describe, expect, it } from 'vitest'
import {
  applySlashSuggestion,
  classifyNativeChatSend,
  filterSlashCommands,
  getAgentSlashCommands,
  isSlashCommandDraft,
  nativeChatSlashCommandOpensAgentPicker,
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

  it('offers Claude /resume, so the `/` menu can reach a prior conversation', () => {
    // STA-4617: the catalog is the only source the `/` menu and send
    // classification read, so an omitted `/resume` is literally "unavailable".
    expect(getAgentSlashCommands('claude').map((c) => c.name)).toContain('resume')
    expect(getAgentSlashCommands('openclaude').map((c) => c.name)).toContain('resume')
    expect(classifyNativeChatSend('/resume', getAgentSlashCommands('claude'), null, '/')).toBe(
      'command'
    )
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

describe('nativeChatSlashCommandOpensAgentPicker', () => {
  const claude = getAgentSlashCommands('claude')

  it('is true for the commands the TUI answers with its own picker', () => {
    expect(nativeChatSlashCommandOpensAgentPicker('/resume', claude)).toBe(true)
    expect(nativeChatSlashCommandOpensAgentPicker('/resume', getAgentSlashCommands('codex'))).toBe(
      true
    )
  })

  it('is false for catalog commands the agent answers inline', () => {
    expect(nativeChatSlashCommandOpensAgentPicker('/clear', claude)).toBe(false)
    expect(nativeChatSlashCommandOpensAgentPicker('/compact', claude)).toBe(false)
  })

  it('matches the leading token only, like send classification', () => {
    // Leading whitespace is prose to the TUI, so nothing is dispatched and no
    // picker opens; a longer token is a different command entirely.
    expect(nativeChatSlashCommandOpensAgentPicker(' /resume', claude)).toBe(false)
    expect(nativeChatSlashCommandOpensAgentPicker('/resumes', claude)).toBe(false)
    expect(nativeChatSlashCommandOpensAgentPicker('resume the work', claude)).toBe(false)
  })

  it('is true when the command carries arguments', () => {
    expect(nativeChatSlashCommandOpensAgentPicker('/resume last', claude)).toBe(true)
  })

  it('is false against an empty catalog (Grok has no verified commands)', () => {
    expect(nativeChatSlashCommandOpensAgentPicker('/resume', [])).toBe(false)
  })
})
