// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { RuntimeHostAccessForm } from './RuntimeHostAccessForm'

function accessLink(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://100.76.32.125:6768',
    deviceToken: 'secret-device-token',
    publicKeyB64: 'secret-public-key',
    scope: 'runtime'
  })
}

function renderForm(onSubmit: (allowLoopback: boolean) => void): HTMLInputElement {
  render(
    <RuntimeHostAccessForm
      name="한국 서버"
      accessLink={accessLink()}
      busy={false}
      failure={null}
      onNameChange={() => {}}
      onAccessLinkChange={() => {}}
      onCancel={() => {}}
      onSubmit={onSubmit}
    />
  )
  return screen.getByLabelText('Name in Orca') as HTMLInputElement
}

afterEach(cleanup)

describe('RuntimeHostAccessForm IME implicit submit', () => {
  it('does not pair a host on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('pairs a host exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
