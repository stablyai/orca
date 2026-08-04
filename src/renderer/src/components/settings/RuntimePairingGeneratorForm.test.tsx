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
  }
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
