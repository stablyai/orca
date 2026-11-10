import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelOrcaCloudAfterCheckout,
  emitOrcaCloudCheckoutReturn,
  onOrcaCloudCheckoutReturn,
  requestOrcaCloudAfterCheckout,
  resetOrcaCloudAfterCheckout,
  takeOrcaCloudCheckoutReturn
} from './orca-cloud-after-checkout'

const composerOpen = { composerOpen: true, hasCreation: () => true }
const composerClosed = { composerOpen: false, hasCreation: () => true }

describe('select Orca Cloud after checkout', () => {
  afterEach(() => resetOrcaCloudAfterCheckout())

  it('lands on the Team page when no wall asked', () => {
    expect(takeOrcaCloudCheckoutReturn(composerOpen)).toEqual({ kind: 'team-page' })
  })

  it('returns to the open composer once, then the intent is consumed', () => {
    requestOrcaCloudAfterCheckout({ kind: 'composer' }, 1_000)
    expect(takeOrcaCloudCheckoutReturn(composerOpen, 2_000)).toEqual({
      kind: 'select-in-composer'
    })
    expect(takeOrcaCloudCheckoutReturn(composerOpen, 3_000)).toEqual({ kind: 'team-page' })
  })

  it('reopens the composer on Orca Cloud when it closed while paying', () => {
    requestOrcaCloudAfterCheckout({ kind: 'composer' }, 1_000)
    expect(takeOrcaCloudCheckoutReturn(composerClosed, 2_000)).toEqual({ kind: 'open-composer' })
  })

  it('retries the refused creation, or falls back to the composer when it was dismissed', () => {
    requestOrcaCloudAfterCheckout({ kind: 'retry', creationId: 'c1' }, 1_000)
    expect(takeOrcaCloudCheckoutReturn(composerClosed, 2_000)).toEqual({
      kind: 'retry',
      creationId: 'c1'
    })
    requestOrcaCloudAfterCheckout({ kind: 'retry', creationId: 'gone' }, 1_000)
    expect(
      takeOrcaCloudCheckoutReturn({ composerOpen: false, hasCreation: () => false }, 2_000)
    ).toEqual({ kind: 'open-composer' })
  })

  it('drops a cancelled or abandoned intent', () => {
    requestOrcaCloudAfterCheckout({ kind: 'composer' }, 1_000)
    cancelOrcaCloudAfterCheckout()
    expect(takeOrcaCloudCheckoutReturn(composerOpen, 2_000)).toEqual({ kind: 'team-page' })
    requestOrcaCloudAfterCheckout({ kind: 'composer' }, 0)
    expect(takeOrcaCloudCheckoutReturn(composerOpen, 31 * 60_000)).toEqual({ kind: 'team-page' })
  })

  it('notifies listening composers until they unsubscribe', () => {
    const listener = vi.fn()
    const off = onOrcaCloudCheckoutReturn(listener)
    emitOrcaCloudCheckoutReturn()
    off()
    emitOrcaCloudCheckoutReturn()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
