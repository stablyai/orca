import { expect, it } from 'vitest'
import type { TerminalQuickCommand } from '../../../shared/terminal/quick-commands/terminal-quick-command-types'
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
