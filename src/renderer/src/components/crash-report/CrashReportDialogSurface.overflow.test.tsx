// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
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
