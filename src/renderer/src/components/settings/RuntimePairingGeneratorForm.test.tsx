import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { TooltipProvider } from '../ui/tooltip'
import {
  RuntimePairingGeneratorForm,
  type RuntimePairingIntent
} from './RuntimePairingGeneratorForm'

type StoreState = {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
  connectCurrentOrcaProfile: () => Promise<null>
  fetchOrcaProfileAuthStatus: () => Promise<null>
}

const store = vi.hoisted(() => {
  const state: StoreState = {
    orcaProfileAuthStatus: null,
    connectCurrentOrcaProfile: () => Promise.resolve(null),
    fetchOrcaProfileAuthStatus: () => Promise.resolve(null)
  }
  return { state }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(store.state)
}))

function renderForm(
  intent: RuntimePairingIntent,
  selectedAddress: string,
  generated?: {
    address: string
    runtimePairingUrl: string
    webClientUrl: string | null
    relayInviteExpiresAt?: number
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
        relayInviteExpiresAt={generated?.relayInviteExpiresAt ?? null}
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

  it('keeps Relay and direct links apart when the choice changes', () => {
    const relayLink = {
      address: '100.76.32.125',
      runtimePairingUrl: 'orca://pair?code=relay-secret',
      webClientUrl: null,
      relayInviteExpiresAt: Date.now() + 600_000
    }

    const underRelay = renderForm('relay', '100.76.32.125', relayLink)
    expect(underRelay).toContain('relay-secret')
    expect(underRelay).toContain('It works once.')
    expect(underRelay).not.toContain('Open in browser')

    const underDirect = renderForm('another', '100.76.32.125', relayLink)
    expect(underDirect).not.toContain('relay-secret')
    expect(underDirect).not.toContain('The connection address changed.')

    const directUnderRelay = renderForm('relay', '100.76.32.125', {
      address: '100.76.32.125',
      runtimePairingUrl: 'orca://pair?code=direct-secret',
      webClientUrl: 'https://example.test/?pair=direct-secret'
    })
    expect(directUnderRelay).not.toContain('direct-secret')
  })

  it('asks for an Orca sign-in before a Relay link can be generated', () => {
    store.state.orcaProfileAuthStatus = null
    const signedOut = renderForm('relay', '100.76.32.125')
    expect(signedOut).toContain('Sign in for Relay')
    expect(signedOut).toContain('disabled=""')

    store.state.orcaProfileAuthStatus = {
      activeProfileId: 'default',
      configured: true,
      state: 'connected',
      persistence: 'encrypted'
    }
    const signedIn = renderForm('relay', '100.76.32.125')
    expect(signedIn).not.toContain('Sign in for Relay')
    expect(signedIn).not.toContain('disabled=""')
  })
})
