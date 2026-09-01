// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DataRecoveryDialog } from './DataRecoveryDialog'

const PIN = {
  id: 'agent-catalog-pre-v1' as const,
  compatibility: 'previous-binary' as const,
  createdAtMs: 1_752_000_000_000,
  sizeBytes: 1024
}

const UNREADABLE_COPY = /cannot be read, so it cannot be restored/

function installApi(points: unknown[]): void {
  ;(window as unknown as { api: unknown }).api = {
    dataRecovery: {
      listPoints: vi.fn().mockResolvedValue(points),
      restore: vi.fn().mockResolvedValue({ ok: true })
    }
  }
}

describe('DataRecoveryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('offers the restore affordance for a readable point', async () => {
    installApi([{ ...PIN, restorable: true }])
    render(<DataRecoveryDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText('Restore these settings…')).toBeTruthy()
    expect(screen.queryByText(UNREADABLE_COPY)).toBeNull()
  })

  it('withdraws the restore affordance when the point cannot be read', async () => {
    installApi([{ ...PIN, restorable: false }])
    render(<DataRecoveryDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText(UNREADABLE_COPY)).toBeTruthy()
    expect(screen.queryByText('Restore these settings…')).toBeNull()
    // The loss warning describes a restore that can no longer happen.
    expect(screen.queryByText(/discards settings and custom agents/)).toBeNull()
  })

  it('stays restorable for a host that reports no readability at all', async () => {
    installApi([PIN])
    render(<DataRecoveryDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText('Restore these settings…')).toBeTruthy()
  })
})
