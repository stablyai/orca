import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../../../shared/pairing'
import { RuntimeHostAccessForm } from './RuntimeHostAccessForm'

function accessLink(endpoint: string): string {
  return encodePairingOffer({
    v: PAIRING_OFFER_VERSION,
    endpoint,
    deviceToken: 'secret-device-token',
    publicKeyB64: 'secret-public-key',
    scope: 'runtime'
  })
}

function renderForm(endpoint: string): string {
  return renderToStaticMarkup(
    <RuntimeHostAccessForm
      name="Linux workstation"
      accessLink={accessLink(endpoint)}
      busy={false}
      failure={null}
      onNameChange={vi.fn()}
      onAccessLinkChange={vi.fn()}
      onCancel={vi.fn()}
      onSubmit={vi.fn()}
    />
  )
}

describe('RuntimeHostAccessForm', () => {
  it('shows the sanitized destination without credential material', () => {
    const markup = renderForm('ws://100.76.32.125:6768')
    expect(markup).toContain('100.76.32.125:6768')
    expect(markup).toContain('Tailscale address')
    expect(markup).not.toContain('secret-device-token')
    expect(markup).not.toContain('secret-public-key')
  })

  it('blocks accidental loopback and explains the recovery path', () => {
    const markup = renderForm('ws://127.0.0.1:6768')
    expect(markup).toContain('This link points back to this device')
    expect(markup).toContain('I am using an SSH tunnel')
    expect(markup).toContain('disabled')
  })

  it('shows actionable validation for malformed access links', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostAccessForm
        name="Linux workstation"
        accessLink="not-a-link"
        busy={false}
        failure={null}
        onNameChange={vi.fn()}
        onAccessLinkChange={vi.fn()}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(markup).toContain('Enter an Orca access link or bare pairing code.')
    expect(markup).toContain('aria-invalid="true"')
  })

  it('shows the persistence error after host verification succeeds', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostAccessForm
        name="Linux workstation"
        accessLink={accessLink('ws://100.76.32.125:6768')}
        busy={false}
        failure={{
          kind: 'environment-save-failed',
          message: 'A server named "Linux workstation" already exists.'
        }}
        onNameChange={vi.fn()}
        onAccessLinkChange={vi.fn()}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    expect(markup).toContain('Could not save the host')
    expect(markup).toContain('A server named &quot;Linux workstation&quot; already exists.')
  })
})
