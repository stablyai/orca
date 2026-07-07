// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/e2e-config', () => ({ e2eConfig: { exposeStore: false } }))

describe('terminal-pty-ack-gate cumulative totals', () => {
  const ackDataMock = vi.fn()

  beforeEach(() => {
    // Why: the cumulative totals are module state; a fresh module per test
    // mirrors a fresh renderer page (renderer lifecycle reset).
    vi.resetModules()
    ackDataMock.mockClear()
    ;(window as unknown as { api: unknown }).api = { pty: { ackData: ackDataMock } }
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  async function loadAckGate() {
    return await import('./terminal-pty-ack-gate')
  }

  it('sends monotonic cumulative totals alongside per-chunk deltas', async () => {
    const { ackPtyData, getProcessedPtyCharTotals } = await loadAckGate()

    ackPtyData('pty-a', 5)
    ackPtyData('pty-a', 7)
    ackPtyData('pty-b', 3)

    expect(ackDataMock).toHaveBeenNthCalledWith(1, 'pty-a', 5, 5)
    expect(ackDataMock).toHaveBeenNthCalledWith(2, 'pty-a', 7, 12)
    expect(ackDataMock).toHaveBeenNthCalledWith(3, 'pty-b', 3, 3)
    expect(getProcessedPtyCharTotals()).toEqual({ 'pty-a': 12, 'pty-b': 3 })
  })

  it('clears a PTY total so a reused id restarts from zero on both sides', async () => {
    const { ackPtyData, clearProcessedPtyCharTotal, getProcessedPtyCharTotals } =
      await loadAckGate()

    ackPtyData('pty-a', 9)
    clearProcessedPtyCharTotal('pty-a')

    expect(getProcessedPtyCharTotals()).toEqual({})

    ackPtyData('pty-a', 4)
    expect(ackDataMock).toHaveBeenLastCalledWith('pty-a', 4, 4)
  })
})
