import { describe, expect, it } from 'vitest'
import { parseNormalizedTerminalQuickCommands } from './terminal-quick-commands'

describe('parseNormalizedTerminalQuickCommands', () => {
  it('keeps closeTabOnSuccess only when true and accepts lists with and without it', () => {
    const withFlag = {
      id: 'a',
      label: 'Test',
      action: 'terminal-command',
      command: 'pnpm test',
      appendEnter: true,
      closeTabOnSuccess: true,
      scope: { type: 'global' }
    }
    const withoutFlag = { ...withFlag, id: 'b' }
    delete (withoutFlag as Partial<typeof withFlag>).closeTabOnSuccess

    expect(parseNormalizedTerminalQuickCommands([withFlag, withoutFlag])).toEqual([
      withFlag,
      withoutFlag
    ])
    expect(parseNormalizedTerminalQuickCommands([{ ...withFlag, closeTabOnSuccess: false }])).toBe(
      null
    )
  })
})
