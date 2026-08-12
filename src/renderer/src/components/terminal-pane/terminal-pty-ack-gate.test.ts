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

describe('terminal-pty-ack-gate parse-deferred crediting', () => {
  const ackDataMock = vi.fn()

  beforeEach(() => {
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

  it('settles an unclaimed delivery credit at return', async () => {
    const { deliverPtyDataWithDeferredAck } = await loadAckGate()

    deliverPtyDataWithDeferredAck('pty-a', 42, () => {})

    expect(ackDataMock).toHaveBeenCalledWith('pty-a', 42, 42)
  })

  it('defers a claimed credit to the scheduler callback and fires once', async () => {
    const { deliverPtyDataWithDeferredAck, takeCurrentPtyDeliveryAckCredit } = await loadAckGate()
    let credit: (() => void) | null = null

    deliverPtyDataWithDeferredAck('pty-a', 10, () => {
      credit = takeCurrentPtyDeliveryAckCredit()
    })

    // Claimed: nothing credited at delivery return.
    expect(ackDataMock).not.toHaveBeenCalled()
    credit!()
    expect(ackDataMock).toHaveBeenCalledWith('pty-a', 10, 10)
    // Fire-once: split slices / discard paths may re-invoke harmlessly.
    credit!()
    expect(ackDataMock).toHaveBeenCalledTimes(1)
  })

  it('waits for every scheduler write produced by one delivery', async () => {
    const { deliverPtyDataWithDeferredAck, takeCurrentPtyDeliveryAckCredit } = await loadAckGate()
    let first: (() => void) | null = null
    let second: (() => void) | null = null

    deliverPtyDataWithDeferredAck('pty-a', 5, () => {
      first = takeCurrentPtyDeliveryAckCredit()
      second = takeCurrentPtyDeliveryAckCredit()
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    first!()
    expect(ackDataMock).not.toHaveBeenCalled()
    second!()
    expect(ackDataMock).toHaveBeenCalledWith('pty-a', 5, 5)
  })

  it('returns null outside a delivery', async () => {
    const { takeCurrentPtyDeliveryAckCredit } = await loadAckGate()
    expect(takeCurrentPtyDeliveryAckCredit()).toBeNull()
  })

  it('settles the credit when the handler throws so the PTY never wedges', async () => {
    const { deliverPtyDataWithDeferredAck } = await loadAckGate()

    expect(() =>
      deliverPtyDataWithDeferredAck('pty-a', 7, () => {
        throw new Error('bad sidecar')
      })
    ).toThrow('bad sidecar')
    expect(ackDataMock).toHaveBeenCalledWith('pty-a', 7, 7)
  })
})
