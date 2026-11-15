// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import RunningTerminalCloseDialog from './RunningTerminalCloseDialog'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { error: toastError, warning: vi.fn(), success: vi.fn(), dismiss: vi.fn() }
}))

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  useAppStore.setState(initialState, true)
  toastError.mockClear()
})
afterEach(() => {
  cleanup()
  useRunningTerminalCloseConfirmStore.setState({ runningTerminalCloseConfirm: null })
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
      targets: [{ worktreeId: 'wt-1', terminalHost: { kind: 'self' }, chatHosts: [{ kind: 'self' }] }],
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
})
