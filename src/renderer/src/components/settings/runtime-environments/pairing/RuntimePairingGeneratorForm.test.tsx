import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../../ui/tooltip'
import { RuntimePairingGeneratorForm } from './RuntimePairingGeneratorForm'
import type { RuntimePairingIntent } from './runtime-pairing-link-state'

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
