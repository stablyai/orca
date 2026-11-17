// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useDaemonActions } from './useDaemonActions'

const { killAll, warning, info, success } = vi.hoisted(() => ({
  killAll: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  success: vi.fn()
}))
vi.mock('./kill-all-terminal-surfaces', () => ({
  snapshotKillAllTerminalSurfaceIds: () => [],
  runKillAllTerminalSurfaces: killAll
}))
vi.mock('sonner', () => ({ toast: { warning, info, success, error: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it.each([0, 2])(
  'warns about incomplete inventory after reporting %i daemon exits and closes the completed confirmation',
  async (killedCount) => {
    killAll.mockResolvedValue({
      targetCount: 0,
      failedCloseAttemptCount: 0,
      exactKillRejectedCount: 0,
      daemon: { status: 'fulfilled', killedCount, remainingCount: 0, listingIncomplete: true }
    })
    const { result } = renderHook(() => useDaemonActions())
    act(() => result.current.setPending('killAll'))
    await act(async () => result.current.runKillAll())
    expect(warning).toHaveBeenCalledWith(
      'Terminal cleanup finished with warnings.',
      expect.objectContaining({
        description: expect.stringContaining('\nSome sessions couldn’t be checked.')
      })
    )
    expect(info).not.toHaveBeenCalled()
    expect(success).not.toHaveBeenCalled()
    expect(result.current.pending).toBeNull()
  }
)
