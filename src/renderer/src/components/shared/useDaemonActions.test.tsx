// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
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
import type { UnifiedSessionRow } from '@/components/status-bar/resource-usage-merge-types'
import { renderResourceUsageKillDialog } from '@/components/status-bar/resource-usage-kill-dialog'
import { DaemonActionDialog, useDaemonActions } from './useDaemonActions'

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

function killConfirmRow(): UnifiedSessionRow {
  return {
    sessionId: 'session-1',
    paneKey: null,
    pid: 4242,
    label: 'Terminal 1',
    bound: true,
    agentOwnership: 'absent',
    tabId: null,
    cpu: 1,
    memory: 1,
    hasLocalSamples: true
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

// Why: the popover that hosts these confirms sits at z-60 (see ui/popover.tsx).
const POPOVER_Z_INDEX = 60

function zIndexOf(element: Element | null): number {
  const match = /z-\[(\d+)\]/.exec(element?.className ?? '')
  return match ? Number(match[1]) : Number.NaN
}

function expectRenderedDialogAbovePopover(): void {
  expect(zIndexOf(document.querySelector('[data-slot="dialog-overlay"]'))).toBeGreaterThan(
    POPOVER_Z_INDEX
  )
  expect(zIndexOf(document.querySelector('[data-slot="dialog-content"]'))).toBeGreaterThan(
    POPOVER_Z_INDEX
  )
}

// Why: no global RTL cleanup is configured, so portaled dialogs would otherwise
// stack up in the document and the queries above would hit the first render.
describe('resource-manager confirm stacking', () => {
  afterEach(() => {
    cleanup()
  })

  it('paints the daemon confirm above the popover that opened it', () => {
    const { result } = renderHook(() => useDaemonActions())
    act(() => result.current.setPending('restart'))
    render(<DaemonActionDialog api={result.current} />)

    expectRenderedDialogAbovePopover()
  })

  it('paints the kill-session confirm above the popover that opened it', () => {
    render(
      renderResourceUsageKillDialog({
        killConfirm: killConfirmRow(),
        setKillConfirm: vi.fn(),
        killing: false,
        runKillConfirmed: vi.fn()
      })
    )

    expectRenderedDialogAbovePopover()
  })
})
