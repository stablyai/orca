import { expect, it } from 'vitest'
import type { TerminalQuickCommand } from '../../../shared/terminal-quick-command-types'
import { searchTerminalQuickCommands } from './terminal-quick-command-search'

it.each(['Review', 'codex'])('does not scan prompts that cannot improve the %s match', (query) => {
  let promptReads = 0
  const commands: TerminalQuickCommand[] = Array.from({ length: 40 }, (_, index) => ({
    id: String(index),
    label: `Review changes ${index}`,
    action: 'agent-prompt',
    agent: 'codex',
    get prompt() {
      promptReads++
      return 'Inspect all source code. '.repeat(240)
    }
  }))
  expect(searchTerminalQuickCommands(commands, query)).toEqual(commands)
  expect(promptReads).toBe(0)
})

it('keeps body matches that beat an agent substring match', () => {
  const commands: TerminalQuickCommand[] = [
    { id: 'agent-only', label: 'Other', action: 'agent-prompt', agent: 'codex', prompt: 'nothing' },
    { id: 'body-exact', label: 'Other', action: 'agent-prompt', agent: 'codex', prompt: 'dex' },
    { id: 'label', label: 'dex', command: 'nothing', appendEnter: true }
  ]
  expect(searchTerminalQuickCommands(commands, 'dex').map((command) => command.id)).toEqual([
    'label',
    'body-exact',
    'agent-only'
  ])
})

it('keeps equal scores in input order and still searches bodies without a metadata match', () => {
  const commands: TerminalQuickCommand[] = [
    { id: 'first', label: 'codex', command: 'codex', appendEnter: true },
    { id: 'second', label: 'codex', action: 'agent-prompt', agent: 'codex', prompt: 'codex' },
    { id: 'body', label: 'Other', command: 'run the task', appendEnter: true },
    { id: 'none', label: 'Other', command: 'nothing', appendEnter: true }
  ]
  expect(searchTerminalQuickCommands(commands, 'codex').map((command) => command.id)).toEqual([
    'first',
    'second'
  ])
  expect(searchTerminalQuickCommands(commands, 'task').map((command) => command.id)).toEqual([
    'body'
  ])
  expect(searchTerminalQuickCommands(commands, 'absent')).toEqual([])
})
