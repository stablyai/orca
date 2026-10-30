import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalQuickCommandPickerValue,
  TERMINAL_QUICK_COMMAND_SEARCH_QUERY_MAX_BYTES,
  searchTerminalQuickCommands
} from './terminal-quick-command-search'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'

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
})

describe('searching long prompt bodies', () => {
  it('normalizes a saved prompt once, not on every keystroke', () => {
    let bodyReads = 0
    const prompt = `Review the change. ${'context '.repeat(1000)}needle`
    const command: TerminalQuickCommand = {
      id: 'long',
      label: 'Long review',
      action: 'agent-prompt',
      agent: 'claude',
      get prompt() {
        bodyReads += 1
        return prompt
      }
    }

    for (const query of ['n', 'ne', 'nee', 'needle']) {
      expect(searchTerminalQuickCommands([command], query)).toEqual([command])
    }
    expect(bodyReads).toBe(1)
  })
})
