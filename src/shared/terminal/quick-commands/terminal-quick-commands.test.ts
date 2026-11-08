import { describe, expect, it } from 'vitest'
import { parseNormalizedTerminalQuickCommands } from './terminal-quick-commands'

describe('parseNormalizedTerminalQuickCommands', () => {
  it('keeps closeTabOnSuccess only when true and accepts lists with and without it', () => {
    const withoutFlag = {
      id: 'b',
      label: 'Test',
      action: 'terminal-command',
      command: 'pnpm test',
      appendEnter: true,
      scope: { type: 'global' }
    }
    const withFlag = { ...withoutFlag, id: 'a', closeTabOnSuccess: true }

    expect(parseNormalizedTerminalQuickCommands([withFlag, withoutFlag])).toEqual([
      withFlag,
      withoutFlag
    ])
    expect(parseNormalizedTerminalQuickCommands([{ ...withFlag, closeTabOnSuccess: false }])).toBe(
      null
    )
  })
})
