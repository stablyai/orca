import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  endRuntimeUploadSession,
  getRuntimeUploadSession,
  settleRuntimeUploadSession,
  startRuntimeUploadSession,
  subscribeToRuntimeUploadSessions,
  summarizeRuntimeUploadSession,
  toggleRuntimeUploadCollapsed,
  updateRuntimeUploadRow,
  type RuntimeUploadRow
} from './runtime-upload-session-state'

function row(overrides: Partial<RuntimeUploadRow> = {}): RuntimeUploadRow {
  return {
    uploadId: 'a',
    name: 'a.bin',
    sentBytes: 0,
    totalBytes: 100,
    status: 'uploading',
    ...overrides
  }
}

afterEach(() => {
  endRuntimeUploadSession('s')
  endRuntimeUploadSession('other')
})

describe('runtime upload session state', () => {
  it('notifies subscribers when a row advances', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToRuntimeUploadSessions(listener)
    startRuntimeUploadSession('s', [row()])
    updateRuntimeUploadRow('s', 'a', { sentBytes: 25 })

    expect(listener).toHaveBeenCalledTimes(2)
    expect(getRuntimeUploadSession('s')?.rows[0]?.sentBytes).toBe(25)
    unsubscribe()
  })

  it('replaces the row object so a memoized bar re-renders', () => {
    startRuntimeUploadSession('s', [row()])
    const before = getRuntimeUploadSession('s')?.rows[0]
    updateRuntimeUploadRow('s', 'a', { sentBytes: 10 })

    expect(getRuntimeUploadSession('s')?.rows[0]).not.toBe(before)
  })

  it('refuses to drag a cancelled row back into uploading', () => {
    startRuntimeUploadSession('s', [row()])
    updateRuntimeUploadRow('s', 'a', { status: 'cancelled' })
    updateRuntimeUploadRow('s', 'a', { sentBytes: 90, status: 'uploading' })

    const settled = getRuntimeUploadSession('s')?.rows[0]
    expect(settled?.status).toBe('cancelled')
    expect(settled?.sentBytes).toBe(0)
  })

  it('keeps a cancelled row cancelled when the import later reports it failed', () => {
    startRuntimeUploadSession('s', [row()])
    updateRuntimeUploadRow('s', 'a', { status: 'cancelled' })
    updateRuntimeUploadRow('s', 'a', { status: 'failed' })

    expect(getRuntimeUploadSession('s')?.rows[0]?.status).toBe('cancelled')
  })

  it('leaves other sessions untouched', () => {
    startRuntimeUploadSession('s', [row()])
    startRuntimeUploadSession('other', [row({ uploadId: 'b' })])
    updateRuntimeUploadRow('s', 'a', { sentBytes: 50 })

    expect(getRuntimeUploadSession('other')?.rows[0]?.sentBytes).toBe(0)
  })

  it('ignores updates for a session that already ended', () => {
    startRuntimeUploadSession('s', [row()])
    endRuntimeUploadSession('s')

    expect(() => updateRuntimeUploadRow('s', 'a', { sentBytes: 10 })).not.toThrow()
    expect(getRuntimeUploadSession('s')).toBeUndefined()
  })

  it('keeps rows when settled so the panel can state the outcome', () => {
    startRuntimeUploadSession('s', [row({ status: 'cancelled' })])
    settleRuntimeUploadSession('s')

    const session = getRuntimeUploadSession('s')
    expect(session?.settled).toBe(true)
    expect(session?.rows).toHaveLength(1)
  })

  it('toggles collapse in the store so the panel can be remounted to re-measure', () => {
    startRuntimeUploadSession('s', [row()])
    expect(getRuntimeUploadSession('s')?.collapsed).toBe(false)

    toggleRuntimeUploadCollapsed('s')
    expect(getRuntimeUploadSession('s')?.collapsed).toBe(true)

    toggleRuntimeUploadCollapsed('s')
    expect(getRuntimeUploadSession('s')?.collapsed).toBe(false)
  })

  it('survives a collapse toggle on a session that already ended', () => {
    expect(() => toggleRuntimeUploadCollapsed('gone')).not.toThrow()
  })

  it('settles only once', () => {
    startRuntimeUploadSession('s', [row()])
    settleRuntimeUploadSession('s')
    const listener = vi.fn()
    const unsubscribe = subscribeToRuntimeUploadSessions(listener)
    settleRuntimeUploadSession('s')

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not notify when nothing actually changed', () => {
    startRuntimeUploadSession('s', [row({ status: 'done' })])
    const listener = vi.fn()
    const unsubscribe = subscribeToRuntimeUploadSessions(listener)
    updateRuntimeUploadRow('s', 'a', { sentBytes: 10 })

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('summarizeRuntimeUploadSession', () => {
  it('averages across rows by bytes, not by row count', () => {
    const summary = summarizeRuntimeUploadSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ uploadId: 'a', sentBytes: 10, totalBytes: 10 }),
        row({ uploadId: 'b', sentBytes: 0, totalBytes: 90 })
      ]
    })

    expect(summary.percent).toBe(10)
  })

  it('drops cancelled rows from the denominator so the bar can still finish', () => {
    const summary = summarizeRuntimeUploadSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ uploadId: 'a', sentBytes: 100, totalBytes: 100, status: 'done' }),
        row({ uploadId: 'b', sentBytes: 20, totalBytes: 900, status: 'cancelled' })
      ]
    })

    expect(summary.percent).toBe(100)
    expect(summary.totalBytes).toBe(100)
  })

  it('counts only rows still moving as active', () => {
    const summary = summarizeRuntimeUploadSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [
        row({ uploadId: 'a', status: 'done' }),
        row({ uploadId: 'b', status: 'uploading' }),
        row({ uploadId: 'c', status: 'cancelled' })
      ]
    })

    expect(summary.activeCount).toBe(1)
  })

  it('is zero percent rather than NaN for an all-empty drop', () => {
    const summary = summarizeRuntimeUploadSession({
      sessionId: 's',
      settled: true,
      collapsed: false,
      rows: [row({ sentBytes: 0, totalBytes: 0 })]
    })

    expect(summary.percent).toBe(0)
  })
})
