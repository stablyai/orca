// @vitest-environment happy-dom
// END-PASS CHAT-RENEW latency: a running cloud pane re-reads the account on window focus, so a
// revoke made while the window sat behind another app shows as soon as the person comes back.
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reads = vi.hoisted(() => ({ ensure: 0, reload: 0, loadedAt: 0 }))

vi.mock('./orca-cloud-agent-accounts-store', () => ({
  orcaCloudAgentAccountsLoadedAt: () => reads.loadedAt,
  // The store's own freshness rule: a read older than 30 s is redone.
  ensureFreshOrcaCloudAgentAccounts: async () => {
    reads.ensure += 1
    if (Date.now() - reads.loadedAt > 30_000) {
      reads.reload += 1
      reads.loadedAt = Date.now()
    }
  },
  reloadOrcaCloudAgentAccounts: async () => {
    reads.reload += 1
    reads.loadedAt = Date.now()
  }
}))

const { useCloudRunningAccountReads } = await import('./cloud-running-agent-signout')

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
  reads.ensure = 0
  reads.reload = 0
  reads.loadedAt = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useCloudRunningAccountReads', () => {
  it('reads on mount, and again at once on focus when the last read is a poll old', () => {
    const view = renderHook(() => useCloudRunningAccountReads(true))
    expect(reads.reload).toBe(1)
    // The window sat unfocused for a minute (the poll slows behind another app).
    vi.setSystemTime(Date.now() + 60_000)
    const before = reads.reload
    window.dispatchEvent(new Event('focus'))
    expect(reads.reload).toBeGreaterThan(before)
    view.unmount()
  })

  it('a focus right after a read does not re-read (one read per ~30 s)', () => {
    const view = renderHook(() => useCloudRunningAccountReads(true))
    vi.setSystemTime(Date.now() + 5_000)
    const before = reads.reload
    window.dispatchEvent(new Event('focus'))
    expect(reads.reload).toBe(before)
    view.unmount()
  })

  it('an inactive pane installs no focus read', () => {
    const view = renderHook(() => useCloudRunningAccountReads(false))
    window.dispatchEvent(new Event('focus'))
    expect(reads.ensure + reads.reload).toBe(0)
    view.unmount()
  })
})
