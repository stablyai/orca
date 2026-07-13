import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { setMountedWorktreeTerminalAutoScroll } from './use-worktree-terminal-auto-scroll'

const mocks = vi.hoisted(() => ({
  followTerminalOutput: vi.fn(),
  pinTerminalOutput: vi.fn()
}))

vi.mock('./terminal-auto-scroll', () => ({
  followTerminalOutput: mocks.followTerminalOutput,
  pinTerminalOutput: mocks.pinTerminalOutput
}))

function makeManager(terminals: unknown[]): PaneManager {
  return {
    getPanes: () => terminals.map((terminal) => ({ terminal }))
  } as unknown as PaneManager
}

describe('setMountedWorktreeTerminalAutoScroll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('restores follow-output for every split pane in a selected worktree', () => {
    const firstTerminal = {}
    const secondTerminal = {}

    expect(
      setMountedWorktreeTerminalAutoScroll(
        { worktreeIds: ['wt-1', 'wt-2'], enabled: true },
        'wt-1',
        makeManager([firstTerminal, secondTerminal])
      )
    ).toBe(true)
    expect(mocks.followTerminalOutput).toHaveBeenNthCalledWith(1, firstTerminal)
    expect(mocks.followTerminalOutput).toHaveBeenNthCalledWith(2, secondTerminal)
  })

  it('pins every split pane when auto-scroll is disabled', () => {
    const firstTerminal = {}
    const secondTerminal = {}

    expect(
      setMountedWorktreeTerminalAutoScroll(
        { worktreeIds: ['wt-1'], enabled: false },
        'wt-1',
        makeManager([firstTerminal, secondTerminal])
      )
    ).toBe(true)
    expect(mocks.pinTerminalOutput).toHaveBeenNthCalledWith(1, firstTerminal)
    expect(mocks.pinTerminalOutput).toHaveBeenNthCalledWith(2, secondTerminal)
    expect(mocks.followTerminalOutput).not.toHaveBeenCalled()
  })

  it('ignores requests for another worktree or a parked manager', () => {
    expect(
      setMountedWorktreeTerminalAutoScroll(
        { worktreeIds: ['wt-2'], enabled: true },
        'wt-1',
        makeManager([{}])
      )
    ).toBe(false)
    expect(
      setMountedWorktreeTerminalAutoScroll({ worktreeIds: ['wt-1'], enabled: true }, 'wt-1', null)
    ).toBe(false)
    expect(mocks.followTerminalOutput).not.toHaveBeenCalled()
  })
})
