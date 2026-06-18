import { describe, expect, it } from 'vitest'
import {
  getTerminalQuickCommandPickerValue,
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
})
