import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalQuickCommandPickerValue,
  isTerminalQuickCommandSearchQueryTooLarge,
  TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES,
  searchTerminalQuickCommands
} from './terminal-quick-command-search'
import type { TerminalQuickCommand } from '../../../shared/types'

const commands: TerminalQuickCommand[] = [
  {
    id: 'dev',
    label: 'dev',
    action: 'terminal-command',
    command: 'pnpm dev',
    appendEnter: true
  },
  {
    id: 'review',
    label: 'codex-code-review',
    action: 'agent-prompt',
    agent: 'codex',
    prompt: 'Review all code changes'
  },
  {
    id: 'simulate',
    label: 'simulate new user',
    action: 'terminal-command',
    command: 'pnpm simulate-new-user',
    appendEnter: true
  }
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal quick command search', () => {
  it('returns all commands for an empty query', () => {
    expect(searchTerminalQuickCommands(commands, '')).toEqual(commands)
  })

  it('matches label, body, and agent text', () => {
    expect(searchTerminalQuickCommands(commands, 'dev').map((command) => command.id)).toEqual([
      'dev'
    ])
    expect(searchTerminalQuickCommands(commands, 'codex').map((command) => command.id)).toEqual([
      'review'
    ])
    expect(
      searchTerminalQuickCommands(commands, 'review all').map((command) => command.id)
    ).toEqual(['review'])
    expect(searchTerminalQuickCommands(commands, 'simulate').map((command) => command.id)).toEqual([
      'simulate'
    ])
  })

  it('normalizes accepted multiline pasted search text without regex replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    expect(
      searchTerminalQuickCommands(commands, '  review\n\tall  ').map((command) => command.id)
    ).toEqual(['review'])

    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('prefers the recent command when the query is empty', () => {
    expect(
      getTerminalQuickCommandPickerValue({
        preferredCommandId: 'simulate',
        filteredCommands: commands,
        rawQuery: ''
      })
    ).toBe('simulate')
  })

  it('selects the first filtered match while searching', () => {
    expect(
      getTerminalQuickCommandPickerValue({
        preferredCommandId: 'dev',
        filteredCommands: searchTerminalQuickCommands(commands, 'codex'),
        rawQuery: 'codex'
      })
    ).toBe('review')
  })

  it('returns no commands for oversized pasted search text before reading commands', () => {
    const unreadableCommand = { ...commands[0] }
    Object.defineProperty(unreadableCommand, 'label', {
      get() {
        throw new Error('command should not be scanned')
      }
    })

    expect(
      searchTerminalQuickCommands(
        [unreadableCommand],
        'x'.repeat(TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES + 1)
      )
    ).toEqual([])
  })

  it('does not select a command for oversized pasted search text', () => {
    const unreadableCommand = { ...commands[0] }
    Object.defineProperty(unreadableCommand, 'id', {
      get() {
        throw new Error('command should not be inspected')
      }
    })

    expect(
      getTerminalQuickCommandPickerValue({
        preferredCommandId: 'dev',
        filteredCommands: [unreadableCommand],
        rawQuery: 'x'.repeat(TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES + 1)
      })
    ).toBe('')
  })

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    expect(
      isTerminalQuickCommandSearchQueryTooLarge(
        'é'.repeat(TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES / 2 + 1)
      )
    ).toBe(true)
  })
})
