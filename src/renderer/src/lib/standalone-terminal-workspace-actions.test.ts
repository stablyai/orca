// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

const mocks = vi.hoisted(() => ({
  activateTab: vi.fn(),
  createTab: vi.fn(),
  getFloatingTerminalCwd: vi.fn(),
  setActiveTabType: vi.fn(),
  setActiveView: vi.fn(),
  setActiveWorktree: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeGroupIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: 'group-1' },
      activateTab: mocks.activateTab,
      createTab: mocks.createTab,
      setActiveTabType: mocks.setActiveTabType,
      setActiveView: mocks.setActiveView,
      setActiveWorktree: mocks.setActiveWorktree
    })
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import {
  activateStandaloneTerminalState,
  createStandaloneTerminalAtHome
} from './standalone-terminal-workspace-actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createTab.mockReturnValue({ id: 'terminal-1' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { getFloatingTerminalCwd: mocks.getFloatingTerminalCwd }
    }
  })
})

afterEach(() => vi.restoreAllMocks())

describe('standalone terminal workspace actions', () => {
  it('activates the terminal view before selecting a standalone terminal tab', () => {
    activateStandaloneTerminalState('terminal-1')

    expect(mocks.setActiveView).toHaveBeenCalledWith('terminal')
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(FLOATING_TERMINAL_WORKTREE_ID)
    expect(mocks.setActiveTabType).toHaveBeenCalledWith('terminal')
    expect(mocks.activateTab).toHaveBeenCalledWith('terminal-1')
    expect(mocks.setActiveTabType.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateTab.mock.invocationCallOrder[0]
    )
  })

  it('creates a terminal with the resolved home directory', async () => {
    const onActivateTerminal = vi.fn()
    mocks.getFloatingTerminalCwd.mockResolvedValue('/Users/orca')

    await createStandaloneTerminalAtHome(onActivateTerminal)

    expect(mocks.createTab).toHaveBeenCalledWith(
      FLOATING_TERMINAL_WORKTREE_ID,
      'group-1',
      undefined,
      { activate: false, startupCwd: '/Users/orca' }
    )
    expect(onActivateTerminal).toHaveBeenCalledWith('terminal-1')
  })

  it('does not create a terminal when the home directory cannot be resolved', async () => {
    const onActivateTerminal = vi.fn()
    const error = new Error('home unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.getFloatingTerminalCwd.mockRejectedValue(error)

    await createStandaloneTerminalAtHome(onActivateTerminal)

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to resolve the home directory for a standalone terminal',
      error
    )
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not open the terminal because the home directory could not be resolved.'
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(onActivateTerminal).not.toHaveBeenCalled()
  })

  it('does not create a terminal when home resolution returns an empty path', async () => {
    const onActivateTerminal = vi.fn()
    mocks.getFloatingTerminalCwd.mockResolvedValue('')

    await createStandaloneTerminalAtHome(onActivateTerminal)

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not open the terminal because the home directory could not be resolved.'
    )
    expect(mocks.createTab).not.toHaveBeenCalled()
    expect(onActivateTerminal).not.toHaveBeenCalled()
  })
})
