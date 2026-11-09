import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  endTransferSession,
  getTransferSession,
  settleTransferSession,
  startTransferSession,
  subscribeToTransferSessions,
  summarizeTransferSession,
  toggleTransferCollapsed,
  updateTransferRow,
  type TransferRow
} from './transfer-session-state'

function row(overrides: Partial<TransferRow> = {}): TransferRow {
  return {
    transferId: 'a',
    name: 'a.bin',
    sentBytes: 0,
    totalBytes: 100,
    status: 'active',
    ...overrides
  }
}

afterEach(() => {
  endTransferSession('s')
  endTransferSession('other')
})

describe('runtime upload session state', () => {
  it('notifies subscribers when a row advances', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToTransferSessions(listener)
    startTransferSession('s', [row()])
    updateTransferRow('s', 'a', { sentBytes: 25 })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getTransferSession('s')?.rows[0]?.sentBytes).toBe(25)
    unsubscribe()
  })

  it('replaces the row object so a memoized bar re-renders', () => {
    startTransferSession('s', [row()])
    const before = getTransferSession('s')?.rows[0]
    updateTransferRow('s', 'a', { sentBytes: 10 })

    expect(getTransferSession('s')?.rows[0]).not.toBe(before)
  })

  it('refuses to drag a cancelled row back into uploading', () => {
    startTransferSession('s', [row()])
    updateTransferRow('s', 'a', { status: 'cancelled' })
    updateTransferRow('s', 'a', { sentBytes: 90, status: 'active' })

    const settled = getTransferSession('s')?.rows[0]
    expect(settled?.status).toBe('cancelled')
    expect(settled?.sentBytes).toBe(0)
  })

  it('leaves other sessions untouched', () => {
    startTransferSession('s', [row()])
    startTransferSession('other', [row({ transferId: 'b' })])
    updateTransferRow('s', 'a', { sentBytes: 50 })

    expect(getTransferSession('other')?.rows[0]?.sentBytes).toBe(0)
  })

  it('keeps rows when settled so the panel can state the outcome', () => {
    startTransferSession('s', [row({ status: 'cancelled' })])
    settleTransferSession('s')

    const session = getTransferSession('s')
    expect(session?.settled).toBe(true)
    expect(session?.rows).toHaveLength(1)
  })

  it('toggles collapse in the store so the panel can be remounted to re-measure', () => {
    startTransferSession('s', [row()])
    expect(getTransferSession('s')?.collapsed).toBe(false)

    toggleTransferCollapsed('s')
    expect(getTransferSession('s')?.collapsed).toBe(true)

    toggleTransferCollapsed('s')
    expect(getTransferSession('s')?.collapsed).toBe(false)
  })

  it('settles only once', () => {
    startTransferSession('s', [row()])
    settleTransferSession('s')
    const listener = vi.fn()
    const unsubscribe = subscribeToTransferSessions(listener)
    settleTransferSession('s')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not notify when nothing actually changed', () => {
    startTransferSession('s', [row({ status: 'done' })])
    const listener = vi.fn()
    const unsubscribe = subscribeToTransferSessions(listener)
    updateTransferRow('s', 'a', { sentBytes: 10 })

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('summarizeTransferSession', () => {
  it('averages across rows by bytes, not by row count', () => {
    const summary = summarizeTransferSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ transferId: 'a', sentBytes: 10, totalBytes: 10 }),
        row({ transferId: 'b', sentBytes: 0, totalBytes: 90 })
      ]
    })

    expect(summary.percent).toBe(10)
  })

  it('drops cancelled rows from the denominator so the bar can still finish', () => {
    const summary = summarizeTransferSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ transferId: 'a', sentBytes: 100, totalBytes: 100, status: 'done' }),
        row({ transferId: 'b', sentBytes: 20, totalBytes: 900, status: 'cancelled' })
      ]
    })

    expect(summary.percent).toBe(100)
    expect(summary.totalBytes).toBe(100)
  })

  it('counts only rows still moving as active', () => {
    const summary = summarizeTransferSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ transferId: 'a', status: 'done' }),
        row({ transferId: 'b', status: 'active' }),
        row({ transferId: 'c', status: 'cancelled' })
      ]
    })

    expect(summary.activeCount).toBe(1)
  })

  it('is zero percent rather than NaN for an all-empty drop', () => {
    const summary = summarizeTransferSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [row({ sentBytes: 0, totalBytes: 0, status: 'done' })]
    })

    expect(summary.percent).toBe(0)
  })

  it('lets a cancelling row still move and still take the outcome its result reports', () => {
    startTransferSession('s', [row({ status: 'cancelling' })])

    updateTransferRow('s', 'a', { sentBytes: 40 })
    updateTransferRow('s', 'a', { status: 'active' })
    updateTransferRow('s', 'a', { status: 'done' })

    expect(getTransferSession('s')?.rows[0]).toMatchObject({ sentBytes: 40, status: 'done' })
  })
})

describe('unconfirmed cancels', () => {
  it('still take the late result, but never slide back to cancelling or active', () => {
    startTransferSession('s', [row({ status: 'unconfirmed' })])

    updateTransferRow('s', 'a', { status: 'cancelling' })
    updateTransferRow('s', 'a', { status: 'active' })
    expect(getTransferSession('s')?.rows[0]?.status).toBe('unconfirmed')

    updateTransferRow('s', 'a', { status: 'cancelled' })
    expect(getTransferSession('s')?.rows[0]?.status).toBe('cancelled')
  })
})
