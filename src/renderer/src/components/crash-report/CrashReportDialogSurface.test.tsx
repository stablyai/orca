// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { CrashReportDialogSurface } from './CrashReportDialogSurface'

vi.mock('sonner', () => ({
  toast: { dismiss: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('honors attachment consent when sending a manually opened freeze report', async () => {
  const report: CrashReportRecord = {
    id: 'freeze-report-1',
    createdAt: '2026-11-12T01:00:00.000Z',
    status: 'dismissed',
    source: 'child',
    processType: 'main',
    reason: 'main-thread-hang',
    exitCode: null,
    appVersion: '1.4.214',
    platform: 'darwin',
    osRelease: '25.1.0',
    arch: 'arm64',
    electronVersion: '43',
    chromeVersion: '150',
    details: { captureId: 'incident-1', detectedAt: '2026-11-11T23:00:00.000Z' }
  }
  const submit = vi.fn().mockResolvedValue({ ok: true, report: { ...report, status: 'sent' } })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { viewer: () => Promise.resolve(null) },
      crashReports: { submit }
    }
  })
  const onOpenChange = vi.fn()
  await act(async () => {
    render(
      <CrashReportDialogSurface
        open
        report={report}
        loading={false}
        onOpenChange={onOpenChange}
        onReportChange={() => {}}
      />
    )
  })
  expect(submit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send Report' }))
  })
  expect(submit).toHaveBeenCalledWith({
    reportId: 'freeze-report-1',
    notes: '',
    includeDiagnosticLogs: false,
    submitAnonymously: true,
    githubLogin: null,
    githubEmail: null
  })
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
