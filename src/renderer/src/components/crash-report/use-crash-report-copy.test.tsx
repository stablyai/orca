// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type {
  CrashReportCopySubmissionFailure,
  CrashReportRecord
} from '../../../../shared/crash-reporting'
import { CRASH_REPORT_COPY_FAILURE_TOAST_ID, useCrashReportCopy } from './use-crash-report-copy'

const copyLatestDiagnostics = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn()
  }
}))

function report(id = 'crash-1'): CrashReportRecord {
  return {
    id,
    createdAt: '2026-05-16T01:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: 'win32',
    osRelease: 'test',
    arch: 'x64',
    electronVersion: '41',
    chromeVersion: '141',
    details: {}
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  copyLatestDiagnostics.mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { crashReports: { copyLatestDiagnostics } }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useCrashReportCopy', () => {
  it('uses the latest edited notes from an older failure-toast action', async () => {
    const failure: CrashReportCopySubmissionFailure = {
      error: 'report request timed out',
      diagnosticContext: { status: 'not_uploaded', reason: 'logs timed out' }
    }
    const { result, rerender } = renderHook(({ notes }) => useCrashReportCopy(report(), notes), {
      initialProps: { notes: 'notes at submit' }
    })
    const failureToastCopyAction = result.current

    rerender({ notes: 'notes edited while waiting' })
    await act(async () => failureToastCopyAction(failure))

    expect(copyLatestDiagnostics).toHaveBeenCalledWith({
      reportId: 'crash-1',
      notes: 'notes edited while waiting',
      submissionFailure: failure
    })
  })

  it("does not combine an older report action with a newer report's notes", async () => {
    const { result, rerender } = renderHook(
      ({ currentReport, notes }) => useCrashReportCopy(currentReport, notes),
      {
        initialProps: {
          currentReport: report('crash-a'),
          notes: 'latest notes for A'
        }
      }
    )
    const reportACopyAction = result.current

    rerender({ currentReport: report('crash-b'), notes: 'private notes for B' })
    await act(async () => reportACopyAction())

    expect(copyLatestDiagnostics).toHaveBeenCalledWith({
      reportId: 'crash-a',
      notes: 'latest notes for A'
    })
    expect(JSON.stringify(copyLatestDiagnostics.mock.calls)).not.toContain('private notes for B')
  })

  it('keeps a returned copy failure visible with its safe reason', async () => {
    copyLatestDiagnostics.mockResolvedValueOnce({
      ok: false,
      error: 'Crash diagnostics are too large to copy safely.'
    })
    const { result } = renderHook(() => useCrashReportCopy(report(), 'current notes'))

    await act(async () => result.current())

    expect(toast.error).toHaveBeenCalledWith('Crash report details could not be copied.', {
      id: CRASH_REPORT_COPY_FAILURE_TOAST_ID,
      description: 'Crash diagnostics are too large to copy safely.',
      duration: Infinity,
      dismissible: true
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows a safe sticky error toast when copy IPC rejects', async () => {
    copyLatestDiagnostics.mockRejectedValueOnce(
      new Error('renderer destroyed with token=must-not-be-shown')
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useCrashReportCopy(report(), 'current notes'))

    await act(async () => result.current())

    expect(toast.error).toHaveBeenCalledWith('Crash report details could not be copied.', {
      id: CRASH_REPORT_COPY_FAILURE_TOAST_ID,
      duration: Infinity,
      dismissible: true
    })
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).not.toContain('must-not-be-shown')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
