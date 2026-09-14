// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WorkspaceCleanupInitialScanBanner,
  WorkspaceCleanupSizeScanBanner
} from './workspace-cleanup-dialog-notices'

afterEach(cleanup)

describe('WorkspaceCleanupInitialScanBanner', () => {
  it('puts determinate progress in the title with matching typography', () => {
    render(
      <WorkspaceCleanupInitialScanBanner
        progress={{
          scanId: 'scan-1',
          scannedAt: 1,
          scannedWorktreeCount: 23,
          totalWorktreeCount: 3048,
          candidates: [],
          errors: []
        }}
      />
    )

    expect(screen.getByText('Scanning workspaces (23/3048)')).toBeTruthy()
    expect(screen.queryByText('Checked workspaces so far: 23')).toBeNull()
  })
})

describe('WorkspaceCleanupSizeScanBanner', () => {
  it('explains why scanning is useful and exposes the action', () => {
    render(
      <WorkspaceCleanupSizeScanBanner
        scanning={false}
        scannedCount={0}
        totalCount={0}
        onRun={vi.fn()}
      />
    )

    expect(screen.getByText('Scan workspace sizes')).toBeTruthy()
    expect(
      screen.getByText('Scan disk usage to compare, sort, and filter workspaces by size.')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Scan' })).toBeTruthy()
  })

  it('shows determinate progress and disables duplicate runs', () => {
    render(
      <WorkspaceCleanupSizeScanBanner scanning scannedCount={23} totalCount={100} onRun={vi.fn()} />
    )

    expect(
      (screen.getByRole('button', { name: 'Scanning 23/100' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
