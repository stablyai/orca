// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import RunningTerminalCloseDialog from './RunningTerminalCloseDialog'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const revalidate = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@/components/terminal/tab-lifecycle/terminal-close-sleep', () => ({
  revalidateTerminalCloseSleep: revalidate
}))
vi.mock('sonner', () => ({
  toast: { error: toastError, warning: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
}))

const initialState = useAppStore.getInitialState()
let clock = 0

beforeEach(() => {
  clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  useAppStore.setState(initialState, true)
  toastError.mockClear()
  revalidate.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  cleanup()
  while (useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm) {
    clock += 400
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  }
  vi.mocked(Date.now).mockRestore()
  useAppStore.setState(initialState, true)
})

describe('sleeping instead of closing a terminal', () => {
  it('does not sleep a queued workspace from a rapid second click', async () => {
    const sleep = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'api', { configurable: true, value: { worktrees: { sleep } } })
    const store = useRunningTerminalCloseConfirmStore.getState()
    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      worktreeId: 'wt-1',
      canSleepInstead: true,
      onConfirm: vi.fn()
    })
    store.requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-2',
      copyKind: 'agent',
      worktreeId: 'wt-2',
      canSleepInstead: true,
      onConfirm: vi.fn()
    })
    render(<RunningTerminalCloseDialog />)
    await act(async () => screen.getByRole('button', { name: 'Sleep workspace' }).click())
    await act(async () => screen.getByRole('button', { name: 'Sleep workspace' }).click())
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep.mock.calls[0]?.[0].targets[0].worktreeId).toBe('wt-1')
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.worktreeId
    ).toBe('wt-2')
  })
})
