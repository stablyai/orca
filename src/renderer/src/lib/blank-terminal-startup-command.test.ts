import { describe, expect, it, vi } from 'vitest'
import {
  queueBlankTerminalStartupCommand,
  resolveBlankTerminalStartupCommand
} from './blank-terminal-startup-command'

describe('resolveBlankTerminalStartupCommand', () => {
  it('returns null when the setting is unset, empty, or whitespace', () => {
    expect(resolveBlankTerminalStartupCommand(null)).toBeNull()
    expect(resolveBlankTerminalStartupCommand(undefined)).toBeNull()
    expect(resolveBlankTerminalStartupCommand({})).toBeNull()
    expect(resolveBlankTerminalStartupCommand({ blankTerminalStartupCommand: '' })).toBeNull()
    expect(resolveBlankTerminalStartupCommand({ blankTerminalStartupCommand: '   ' })).toBeNull()
  })

  it('trims surrounding whitespace but keeps inner arguments intact', () => {
    expect(resolveBlankTerminalStartupCommand({ blankTerminalStartupCommand: '  tc  ' })).toBe('tc')
    expect(
      resolveBlankTerminalStartupCommand({ blankTerminalStartupCommand: 'claude --resume ' })
    ).toBe('claude --resume')
  })
})

describe('queueBlankTerminalStartupCommand', () => {
  it('queues the configured command as a plain startup command', () => {
    const queueTabStartupCommand = vi.fn()
    const queued = queueBlankTerminalStartupCommand(
      { settings: { blankTerminalStartupCommand: 'tc' }, queueTabStartupCommand },
      'tab-1'
    )

    expect(queued).toBe(true)
    expect(queueTabStartupCommand).toHaveBeenCalledWith('tab-1', { command: 'tc' })
  })

  it('leaves the tab untouched when no command is configured', () => {
    const queueTabStartupCommand = vi.fn()

    expect(
      queueBlankTerminalStartupCommand({ settings: null, queueTabStartupCommand }, 'tab-1')
    ).toBe(false)
    expect(
      queueBlankTerminalStartupCommand(
        { settings: { blankTerminalStartupCommand: ' ' }, queueTabStartupCommand },
        'tab-1'
      )
    ).toBe(false)
    expect(queueTabStartupCommand).not.toHaveBeenCalled()
  })
})
