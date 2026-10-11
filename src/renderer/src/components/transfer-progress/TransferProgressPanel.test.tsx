// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TransferProgressPanel } from './TransferProgressPanel'
import {
  endTransferSession,
  startTransferSession,
  type TransferRow
} from './transfer-session-state'

function renderRow(row: Omit<TransferRow, 'transferId' | 'name'>): HTMLElement {
  startTransferSession('s', 'download', [{ transferId: 'd', name: 'build', ...row }])
  render(
    <TransferProgressPanel
      sessionId="s"
      onCancel={() => {}}
      onDismiss={() => {}}
      onLayoutChange={() => {}}
    />
  )
  return screen.getByRole('progressbar', { name: 'build' })
}

describe('TransferProgressPanel row bar', () => {
  afterEach(() => {
    cleanup()
    endTransferSession('s')
  })

  it('animates instead of sitting at 0 while bytes move toward an unknown total', () => {
    const bar = renderRow({ sentBytes: 4096, totalBytes: 0, status: 'active' })

    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(bar.innerHTML).toContain('animate-[skill-update-slide')
  })

  it('shows a determinate bar once the total is known', () => {
    const bar = renderRow({ sentBytes: 25, totalBytes: 100, status: 'active' })

    expect(bar.getAttribute('aria-valuenow')).toBe('25')
    expect(bar.innerHTML).not.toContain('skill-update-slide')
  })

  it('stops animating once a row with no total has ended', () => {
    const bar = renderRow({ sentBytes: 4096, totalBytes: 0, status: 'cancelled' })

    expect(bar.innerHTML).not.toContain('skill-update-slide')
  })
})
