// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { RemoteServerFields } from './AddRemoteHostFields'

function accessLink(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://100.76.32.125:6768',
    deviceToken: 'secret-device-token',
    publicKeyB64: 'secret-public-key',
    scope: 'runtime'
  })
}

function renderForm(onSubmit: () => void): HTMLInputElement {
  const pairingCode = accessLink()
  render(
    <RemoteServerFields
      name="한국 서버"
      pairingCode={pairingCode}
      parsedLink={parseHostAccessLink(pairingCode)}
      disabled={false}
      onNameChange={() => {}}
      onPairingCodeChange={() => {}}
      allowLoopback={false}
      onAllowLoopbackChange={() => {}}
      onSubmit={onSubmit}
    />
  )
  return screen.getByLabelText('Server name') as HTMLInputElement
}

afterEach(cleanup)

describe('RemoteServerFields IME implicit submit', () => {
  it('does not pair a remote server on the recorded Korean Enter redispatch', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('pairs a remote server exactly once on an ordinary Enter', () => {
    const onSubmit = vi.fn()
    const input = renderForm(onSubmit)

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
