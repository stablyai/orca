import { describe, expect, it, vi } from 'vitest'
import { applyTerminalScrollbackRowsToMountedPanes } from './mounted-terminal-scrollback'

describe('applyTerminalScrollbackRowsToMountedPanes', () => {
  it('updates mounted pane xterm scrollback options only when needed', () => {
    const firstOptions = { scrollback: 1_000 }
    const secondOptions = { scrollback: 5_000 }
    const firstTerminal = { options: firstOptions }
    let secondWrites = 0
    const secondTerminal = {
      options: {
        get scrollback() {
          return secondOptions.scrollback
        },
        set scrollback(value: number | undefined) {
          secondWrites += 1
          secondOptions.scrollback = value ?? 0
        }
      }
    }
    const manager = {
      getPanes: vi.fn(() => [{ terminal: firstTerminal }, { terminal: secondTerminal }])
    }

    applyTerminalScrollbackRowsToMountedPanes(manager, 5_000)

    expect(firstTerminal.options.scrollback).toBe(5_000)
    expect(secondOptions.scrollback).toBe(5_000)
    expect(secondWrites).toBe(0)
    expect(manager.getPanes).toHaveBeenCalledTimes(1)
  })
})
