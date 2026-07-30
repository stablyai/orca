import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { parseHostAccessLink } from '../../../../shared/remote-pairing-address'
import { RemoteServerFields } from './AddRemoteHostFields'

function loopbackAccessLink(): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'token',
    publicKeyB64: 'key',
    scope: 'runtime'
  })
}

describe('RemoteServerFields', () => {
  it('associates blocked loopback guidance with the access-link input', () => {
    const pairingCode = loopbackAccessLink()
    const markup = renderToStaticMarkup(
      <RemoteServerFields
        name="Remote workstation"
        pairingCode={pairingCode}
        parsedLink={parseHostAccessLink(pairingCode)}
        disabled={false}
        onNameChange={vi.fn()}
        onPairingCodeChange={vi.fn()}
        allowLoopback={false}
        onAllowLoopbackChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(markup).toContain('aria-invalid="true"')
    expect(markup).toContain('aria-describedby="add-server-loopback-blocked"')
    expect(markup).toContain('id="add-server-loopback-blocked"')
  })
})
