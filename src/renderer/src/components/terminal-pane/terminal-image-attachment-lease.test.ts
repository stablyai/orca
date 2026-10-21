import { describe, expect, it, vi } from 'vitest'
import { createTerminalImageAttachmentLease } from './terminal-image-attachment-lease'

describe('unsubmitted image ownership', () => {
  it('discards once on rejection, remove, navigation or repeated cancellation', () => {
    const settle = vi.fn(async () => {})
    const lease = createTerminalImageAttachmentLease({
      isCurrent: () => true,
      settle,
      onError: vi.fn()
    })
    lease.cancel()
    lease.cancel()
    expect(lease.isCurrent()).toBe(false)
    expect(settle).toHaveBeenCalledExactlyOnceWith('discard')
  })
  it('retains a file once delivery starts, even if cancellation races the result', async () => {
    const settle = vi.fn(async () => {})
    const lease = createTerminalImageAttachmentLease({
      isCurrent: () => true,
      settle,
      onError: vi.fn()
    })
    await lease.prepareDelivery()
    await lease.deliveryStarted()
    lease.cancel()
    await expect(lease.deliveryStarted()).rejects.toThrow('canceled')
    await Promise.resolve()
    expect(settle.mock.calls).toEqual([['retain'], ['release']])
  })
  it('checks live admission and reports host cleanup failures', async () => {
    const onError = vi.fn()
    const error = new Error('host unavailable')
    const lease = createTerminalImageAttachmentLease({
      isCurrent: () => false,
      settle: async () => {
        throw error
      },
      onError
    })
    expect(lease.isCurrent()).toBe(false)
    lease.cancel()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
  })
})

it('waits for host retention and discards if canceled while it is in flight', async () => {
  let retained: (() => void) | undefined
  const settle = vi.fn((action: string) =>
    action === 'retain'
      ? new Promise<void>((resolve) => {
          retained = resolve
        })
      : Promise.resolve()
  )
  const lease = createTerminalImageAttachmentLease({
    isCurrent: () => true,
    settle,
    onError: vi.fn()
  })
  const preparing = lease.prepareDelivery()
  lease.cancel()
  expect(settle.mock.calls).toEqual([['retain']])
  retained?.()
  expect(await preparing).toBe(false)
  await Promise.resolve()
  expect(settle.mock.calls).toEqual([['retain'], ['discard']])
})

it('retries a transient release failure rather than caching the rejected attempt', async () => {
  let attempts = 0
  const settle = vi.fn(async (action: string) => {
    if (action === 'release' && ++attempts === 1) {
      throw new Error('temporary failure')
    }
  })
  const lease = createTerminalImageAttachmentLease({
    isCurrent: () => true,
    settle,
    onError: vi.fn()
  })
  expect(await lease.prepareDelivery()).toBe(true)
  await expect(lease.deliveryStarted()).rejects.toThrow('temporary failure')
  expect(await lease.prepareDelivery()).toBe(true)
  await lease.deliveryStarted()
  lease.cancel()
  await Promise.resolve()
  expect(settle.mock.calls).toEqual([['retain'], ['release'], ['retain'], ['release']])
})
