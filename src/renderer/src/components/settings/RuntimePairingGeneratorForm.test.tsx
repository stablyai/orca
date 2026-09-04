import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import {
  RuntimePairingGeneratorForm,
  type RuntimePairingIntent
} from './RuntimePairingGeneratorForm'

function renderForm(
  intent: RuntimePairingIntent,
  selectedAddress: string,
  generated?: {
    address: string
    runtimePairingUrl: string
    webClientUrl: string
  },
  localWebSocketPort: number | null = 6768
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RuntimePairingGeneratorForm
        intent={intent}
        loopbackAddress="127.0.0.1"
        networkInterfaces={[{ name: 'tailscale0', address: '100.76.32.125' }]}
        selectedAddress={selectedAddress}
        refreshingNetworkInterfaces={false}
        isGeneratingPairing={false}
        webClientUrl={generated?.webClientUrl ?? null}
        runtimePairingUrl={generated?.runtimePairingUrl ?? null}
        copiedTarget={null}
        generatedAddress={generated?.address ?? null}
        localWebSocketPort={localWebSocketPort}
        onIntentChange={vi.fn()}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        onGenerate={vi.fn()}
        onCopy={vi.fn()}
      />
    </TooltipProvider>
  )
}

describe('RuntimePairingGeneratorForm', () => {
  it('uses detected interfaces for another-device intent', () => {
    const markup = renderForm('another', '100.76.32.125')
    expect(markup).toContain('role="combobox"')
    expect(markup).not.toContain('id="runtime-pairing-custom-address"')
  })

  it('requires a dedicated value for custom-address intent', () => {
    const emptyMarkup = renderForm('custom', '')
    expect(emptyMarkup).toContain('id="runtime-pairing-custom-address"')
    expect(emptyMarkup).toContain('disabled=""')

    const populatedMarkup = renderForm('custom', 'openclaw.example.ts.net')
    expect(populatedMarkup).toContain('value="openclaw.example.ts.net"')
    expect(populatedMarkup).not.toContain('disabled=""')
  })

  it('shows the cloudflared command against the bound loopback port', () => {
    const markup = renderForm('cloudflare', '')
    expect(markup).toContain('cloudflared tunnel --url http://127.0.0.1:6768')
    expect(markup).toContain('id="runtime-pairing-cloudflare-address"')
    // No tunnel URL yet, so there is nothing to generate against.
    expect(markup).toContain('disabled=""')
  })

  // Why: a copyable command carrying a literal placeholder port is a broken command.
  it('withholds the command instead of printing a placeholder port', () => {
    const markup = renderForm('cloudflare', '', undefined, null)
    expect(markup).not.toContain('cloudflared tunnel')
    expect(markup).toContain('The runtime port is not available yet.')
  })

  // Why: a bare host would inherit the local port and advertise :6768 through an edge on 443, so the
  // form must refuse anything the tunnel parser cannot normalize to a public wss:// URL.
  it('accepts a public tunnel URL and rejects a loopback one', () => {
    const accepted = renderForm('cloudflare', 'https://tidy-otter-plum.trycloudflare.com')
    expect(accepted).not.toContain('disabled=""')
    expect(accepted).toContain('Quick tunnel URLs change every time')

    const rejected = renderForm('cloudflare', 'https://127.0.0.1:6768')
    expect(rejected).toContain('disabled=""')
    expect(rejected).toContain('aria-invalid="true"')
  })

  it('hides generated links after the selected address changes', () => {
    const markup = renderForm('another', '100.76.32.125', {
      address: '192.168.1.10',
      runtimePairingUrl: 'orca://pair?code=stale-secret',
      webClientUrl: 'https://example.test/?pair=stale-secret'
    })

    expect(markup).toContain('The connection address changed.')
    expect(markup).not.toContain('stale-secret')
  })
})
