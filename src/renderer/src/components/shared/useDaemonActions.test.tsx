// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runCleanupMock, snapshotMock, toastErrorMock, toastInfoMock, toastSuccessMock } =
  vi.hoisted(() => ({
    runCleanupMock: vi.fn(),
    snapshotMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastInfoMock: vi.fn(),
    toastSuccessMock: vi.fn()
  }))

vi.mock('./kill-all-terminal-surfaces', () => ({
  runKillAllTerminalSurfaces: runCleanupMock,
  snapshotKillAllTerminalSurfaceIds: snapshotMock
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    info: toastInfoMock,
    success: toastSuccessMock,
    warning: vi.fn()
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import type { KillAllTerminalSurfacesSummary } from './kill-all-terminal-surfaces'
import { DaemonActionDialog, useDaemonActions, type DaemonActionsApi } from './useDaemonActions'

function rejectedSummary(): KillAllTerminalSurfacesSummary {
  return {
    targetCount: 1,
    closeAttemptCount: 1,
    absentTargetCount: 1,
    failedCloseAttemptCount: 0,
    exactKillAcceptedCount: 1,
    exactKillRejectedCount: 0,
    closeDurationMs: 1,
    maxCloseBatchDurationMs: 1,
    closeYieldCount: 0,
    closePhaseExceededLongTaskBudget: false,
    daemon: { status: 'rejected' }
  }
}

function successfulSurfaceSummary(): KillAllTerminalSurfacesSummary {
  return {
    targetCount: 1,
    closeAttemptCount: 1,
    absentTargetCount: 1,
    failedCloseAttemptCount: 0,
    exactKillAcceptedCount: 0,
    exactKillRejectedCount: 0,
    closeDurationMs: 1,
    maxCloseBatchDurationMs: 1,
    closeYieldCount: 0,
    closePhaseExceededLongTaskBudget: false,
    daemon: { status: 'fulfilled', killedCount: 0, remainingCount: 0 }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useDaemonActions kill-all cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    snapshotMock.mockReturnValue(['confirmed-tab'])
  })

  it('snapshots before start and does not revoke cleanup when the caller unmounts', async () => {
    const cleanup = deferred<KillAllTerminalSurfacesSummary>()
    const sequence: string[] = []
    const onKillAllStart = vi.fn(() => sequence.push('start'))
    const onKillAllError = vi.fn()
    const onKillAllSettled = vi.fn()
    snapshotMock.mockImplementation(() => {
      sequence.push('snapshot')
      return ['confirmed-tab']
    })
    runCleanupMock.mockImplementation(() => {
      sequence.push('cleanup')
      return cleanup.promise
    })
    const { result, unmount } = renderHook(() =>
      useDaemonActions({ onKillAllStart, onKillAllError, onKillAllSettled })
    )

    let completion!: Promise<void>
    act(() => {
      completion = result.current.runKillAll()
    })

    expect(sequence).toEqual(['snapshot', 'start', 'cleanup'])
    expect(runCleanupMock).toHaveBeenCalledWith(['confirmed-tab'])
    unmount()
    cleanup.resolve(rejectedSummary())
    await completion

    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    expect(onKillAllError).not.toHaveBeenCalled()
    expect(onKillAllSettled).not.toHaveBeenCalled()
  })

  it('runs mounted error and settled callbacks only after cleanup settlement', async () => {
    const cleanup = deferred<KillAllTerminalSurfacesSummary>()
    const onKillAllError = vi.fn()
    const onKillAllSettled = vi.fn()
    runCleanupMock.mockReturnValue(cleanup.promise)
    const { result } = renderHook(() => useDaemonActions({ onKillAllError, onKillAllSettled }))

    let completion!: Promise<void>
    act(() => {
      completion = result.current.runKillAll()
    })
    expect(onKillAllError).not.toHaveBeenCalled()
    expect(onKillAllSettled).not.toHaveBeenCalled()

    await act(async () => {
      cleanup.resolve(rejectedSummary())
      await completion
    })

    expect(onKillAllError).toHaveBeenCalledTimes(1)
    expect(onKillAllSettled).toHaveBeenCalledTimes(1)
  })

  it('reports closed terminal tabs as success when daemon management found no sessions', async () => {
    runCleanupMock.mockResolvedValue(successfulSurfaceSummary())
    const { result } = renderHook(() => useDaemonActions())

    await act(async () => {
      await result.current.runKillAll()
    })

    expect(toastSuccessMock).toHaveBeenCalledWith(
      'Terminal tabs closed and shutdown requested.',
      expect.any(Object)
    )
    expect(toastInfoMock).not.toHaveBeenCalled()
  })
})

describe('DaemonActionDialog restart copy', () => {
  function pendingRestartApi(): DaemonActionsApi {
    return {
      pending: 'restart',
      setPending: vi.fn(),
      busyKind: null,
      isBusy: false,
      runRestart: vi.fn(async () => {}),
      runKillAll: vi.fn(async () => {}),
      runConfirmed: vi.fn()
    }
  }

  afterEach(() => {
    cleanup()
  })

  // The old copy promised panes showing "Process exited" that the user reopens by hand; agents
  // resume themselves now, so it described a product that no longer exists.
  it('names the terminal service and states only what actually happens', () => {
    render(<DaemonActionDialog api={pendingRestartApi()} />)

    expect(screen.getByText('Restart the terminal service?')).toBeTruthy()
    expect(
      screen.getByText(
        'Open terminals and agents will restart. Terminals on remote hosts are not affected.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
  })

  it('no longer promises reopenable "Process exited" panes', () => {
    render(<DaemonActionDialog api={pendingRestartApi()} />)

    expect(screen.queryByText(/Process exited/)).toBeNull()
    expect(screen.queryByText(/Legacy-protocol sessions/)).toBeNull()
  })
})
