import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANCEL_UNCONFIRMED_AFTER_MS,
  openTransferProgressPanel
} from './open-transfer-progress-panel'
import { endTransferSession, getTransferSession } from './transfer-session-state'

vi.mock('sonner', () => ({ toast: { custom: vi.fn(() => 'toast-1'), dismiss: vi.fn() } }))
vi.mock('@/lib/browser-uuid', () => ({ createBrowserUuid: () => 'panel-1' }))

const rows = [
  { transferId: 'a', name: 'a.bin', sentBytes: 0, totalBytes: 10, status: 'active' as const }
]

describe('openTransferProgressPanel cancel states', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    endTransferSession('panel-1')
  })

  const status = () => getTransferSession('panel-1')?.rows[0]?.status

  it('says the remote state is unconfirmed when no result follows the cancel', () => {
    const panel = openTransferProgressPanel('upload', rows, vi.fn())
    panel.markCancelling('a')
    expect(status()).toBe('cancelling')

    vi.advanceTimersByTime(CANCEL_UNCONFIRMED_AFTER_MS)

    expect(status()).toBe('unconfirmed')
  })

  it('keeps the real result when it arrives before the deadline', () => {
    const panel = openTransferProgressPanel('upload', rows, vi.fn())
    panel.markCancelling('a')
    panel.updateRow('a', { status: 'cancelled' })

    vi.advanceTimersByTime(CANCEL_UNCONFIRMED_AFTER_MS)

    expect(status()).toBe('cancelled')
  })
})
