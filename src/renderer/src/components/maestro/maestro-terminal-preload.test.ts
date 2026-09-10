import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS,
  MAESTRO_TERMINAL_PRELOAD_START_DELAY_MS,
  scheduleMaestroTerminalPreload,
  terminalWorkspaceIdForMaestroKey
} from './maestro-terminal-preload'

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleMaestroTerminalPreload', () => {
  it('preloads one unmounted terminal per interval', () => {
    vi.useFakeTimers()
    const requestMount = vi.fn()
    const isTerminalMounted = vi.fn((tabId: string) => tabId === 'terminal-2')

    scheduleMaestroTerminalPreload({
      worktreeId: 'worktree-1',
      getTerminalTabIds: () => ['terminal-1', 'terminal-2', 'terminal-3'],
      isTerminalMounted,
      requestMount
    })

    vi.advanceTimersByTime(MAESTRO_TERMINAL_PRELOAD_START_DELAY_MS - 1)
    expect(requestMount).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(requestMount).toHaveBeenLastCalledWith({
      worktreeId: 'worktree-1',
      tabIds: ['terminal-1']
    })
    expect(requestMount).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS)
    expect(requestMount).toHaveBeenLastCalledWith({
      worktreeId: 'worktree-1',
      tabIds: ['terminal-3']
    })
    expect(requestMount).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS)
    expect(requestMount).toHaveBeenCalledTimes(2)
  })

  it('cancels terminals that remain in the preload queue', () => {
    vi.useFakeTimers()
    const requestMount = vi.fn()
    const cancel = scheduleMaestroTerminalPreload({
      worktreeId: 'worktree-1',
      getTerminalTabIds: () => ['terminal-1', 'terminal-2'],
      isTerminalMounted: () => false,
      requestMount
    })

    vi.advanceTimersByTime(MAESTRO_TERMINAL_PRELOAD_START_DELAY_MS)
    cancel()
    vi.advanceTimersByTime(MAESTRO_TERMINAL_PRELOAD_INTERVAL_MS)

    expect(requestMount).toHaveBeenCalledOnce()
  })
})

describe('terminalWorkspaceIdForMaestroKey', () => {
  it('maps worktree and folder Canvas keys to terminal store ownership', () => {
    expect(terminalWorkspaceIdForMaestroKey('worktree:worktree-1')).toBe('worktree-1')
    expect(terminalWorkspaceIdForMaestroKey('folder:folder-1')).toBe('folder:folder-1')
    expect(terminalWorkspaceIdForMaestroKey('invalid')).toBeNull()
  })
})
