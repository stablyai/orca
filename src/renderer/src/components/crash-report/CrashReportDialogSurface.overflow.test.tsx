// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import { CrashReportDialogSurface } from './CrashReportDialogSurface'

const viewer = vi.fn(async () => null)

vi.mock('./use-crash-report-copy', () => ({
  useCrashReportCopy: () => vi.fn(async () => {})
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ className, children }: { className?: string; children?: ReactNode }) => (
    <div role="dialog" className={className}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>
}))

function crashReport(error: string): CrashReportRecord {
  return {
    id: 'crash-1',
    createdAt: '2026-08-10T00:00:00.000Z',
    status: 'pending',
    source: 'renderer',
    processType: 'renderer',
    reason: 'crashed',
    exitCode: 5,
    appVersion: '1.0.0',
    platform: 'darwin',
    osRelease: 'test',
    arch: 'arm64',
    electronVersion: '41',
    chromeVersion: '141',
    details: { error }
  }
}

beforeEach(() => {
  viewer.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { viewer } }
  })
})

afterEach(() => cleanup())

describe('CrashReportDialogSurface overflow containment', () => {
  it('keeps unbroken diagnostic output inside the dialog grid', async () => {
    const unbrokenError = 'A'.repeat(1000)
    const { container } = render(
      <CrashReportDialogSurface
        open
        report={crashReport(unbrokenError)}
        loading={false}
        onOpenChange={() => {}}
        onReportChange={() => {}}
        submitting={false}
        onSubmit={async () => ({ ok: true, report: null })}
      />
    )
    await waitFor(() => expect(viewer).toHaveBeenCalledOnce())

    const dialog = container.querySelector('[role="dialog"]')
    const output = dialog?.querySelector('pre')
    expect(output?.textContent).toContain(unbrokenError)
    expect(output?.className).toContain('[overflow-wrap:anywhere]')
    expect(output?.className).not.toContain('break-words')

    const gridChild = Array.from(dialog?.children ?? []).find((child) =>
      child.contains(output ?? null)
    )
    expect(gridChild?.className).toContain('min-w-0')
    expect(output?.parentElement?.className).toContain('min-w-0')
  })
})

it.each(['pending', 'rejected'] as const)(
  "Don't Send closes immediately while dismissal is %s",
  async (outcome) => {
    const pending = Promise.withResolvers<void>()
    Object.assign(window.api, { crashReports: { dismiss: () => pending.promise } })
    const onOpenChange = vi.fn()
    const silent = vi.spyOn(console, 'error').mockImplementation(() => {})
    const screen = render(
      <CrashReportDialogSurface
        open
        report={crashReport('error')}
        loading={false}
        onOpenChange={onOpenChange}
        onReportChange={() => {}}
        submitting={false}
        onSubmit={async () => ({ ok: true, report: null })}
      />
    )
    fireEvent.click(screen.getByText("Don't Send"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    if (outcome === 'rejected') {
      pending.reject(new Error('write failed'))
      await waitFor(() => expect(silent).toHaveBeenCalled())
    }
    silent.mockRestore()
  }
)
