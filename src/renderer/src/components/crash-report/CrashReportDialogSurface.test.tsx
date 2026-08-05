// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CrashReportDialogSurface } from './CrashReportDialogSurface'

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const crashSubmit = vi.fn()
const feedbackSubmit = vi.fn()

function renderUncapturedSurface(): void {
  render(
    <CrashReportDialogSurface
      open
      report={null}
      loading={false}
      onOpenChange={vi.fn()}
      onReportChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  crashSubmit.mockResolvedValue({ ok: true, report: null })
  feedbackSubmit.mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: { viewer: vi.fn().mockResolvedValue({ login: 'octocat' }) },
      crashReports: { submit: crashSubmit, copyLatestDiagnostics: vi.fn() },
      feedback: { submit: feedbackSubmit }
    }
  })
})

afterEach(() => {
  cleanup()
})

describe('CrashReportDialogSurface without a captured crash report', () => {
  it('reads as a user report rather than a crash', async () => {
    renderUncapturedSurface()

    expect(await screen.findByText('Tell us what went wrong')).toBeTruthy()
    expect(screen.getByText(/reaches the Orca team as a user report/i)).toBeTruthy()
  })

  it('keeps the diagnostic bundle by submitting through the crash lane without a report id', async () => {
    const user = userEvent.setup()
    renderUncapturedSurface()

    await user.type(await screen.findByRole('textbox'), 'Korean IME drops the last jamo')
    await user.click(screen.getByRole('button', { name: /send report/i }))

    await waitFor(() => expect(crashSubmit).toHaveBeenCalledTimes(1))
    expect(feedbackSubmit).not.toHaveBeenCalled()
    const submitted = crashSubmit.mock.calls[0][0]
    expect(submitted.reportId).toBeUndefined()
    expect(submitted.includeDiagnosticLogs).toBe(true)
    expect(submitted.notes).toContain('Korean IME drops the last jamo')
  })

  it('still sends a log-only report when the user types no note', async () => {
    const user = userEvent.setup()
    renderUncapturedSurface()

    // Why: two of the field reports were prose-free ("Not connecting SSH") — the
    // bundle was the whole signal, so an empty note must not block submission.
    await user.click(await screen.findByRole('button', { name: /send report/i }))

    await waitFor(() => expect(crashSubmit).toHaveBeenCalledTimes(1))
    expect(crashSubmit.mock.calls[0][0].includeDiagnosticLogs).toBe(true)
  })

  it('offers the diagnostic log toggle', async () => {
    renderUncapturedSurface()

    expect(await screen.findByText('Attach recent diagnostic logs')).toBeTruthy()
  })
})
