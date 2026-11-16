// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import RunningTerminalCloseDialog from './RunningTerminalCloseDialog'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const revalidate = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@/components/terminal/terminal-close-sleep', () => ({
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
  it('keeps the tab and reports a failed sleep request', async () => {
    const sleep = vi.fn().mockRejectedValue(new Error('host unreachable'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { worktrees: { sleep } }
    })
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      worktreeId: 'wt-1',
      canSleepInstead: true,
      onConfirm,
      onCancel
    })
    render(<RunningTerminalCloseDialog />)

    await act(async () => screen.getByRole('button', { name: 'Sleep workspace instead' }).click())
    await waitFor(() => expect(toastError).toHaveBeenCalled())

    expect(sleep).toHaveBeenCalledWith({
      targets: [
        { worktreeId: 'wt-1', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }
      ],
      markChatsAsleep: true
    })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('hides sleep when the request cannot keep the agent resumable', () => {
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      worktreeId: 'wt-1',
      onConfirm: vi.fn()
    })
    render(<RunningTerminalCloseDialog />)
    expect(screen.queryByRole('button', { name: 'Sleep workspace instead' })).toBeNull()
  })

  it('does not sleep when rechecking finds work that cannot resume', async () => {
    revalidate.mockResolvedValue(false)
    const sleep = vi.fn()
    Object.defineProperty(window, 'api', { configurable: true, value: { worktrees: { sleep } } })
    useRunningTerminalCloseConfirmStore.getState().requestRunningTerminalCloseConfirm({
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      worktreeId: 'wt-1',
      canSleepInstead: true,
      onConfirm: vi.fn()
    })
    render(<RunningTerminalCloseDialog />)
    await act(async () => screen.getByRole('button', { name: 'Sleep workspace instead' }).click())
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(sleep).not.toHaveBeenCalled()
  })

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
    await act(async () => screen.getByRole('button', { name: 'Sleep workspace instead' }).click())
    await act(async () => screen.getByRole('button', { name: 'Sleep workspace instead' }).click())
    expect(sleep).toHaveBeenCalledOnce()
    expect(sleep.mock.calls[0]?.[0].targets[0].worktreeId).toBe('wt-1')
    expect(
      useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm?.worktreeId
    ).toBe('wt-2')
  })
})
