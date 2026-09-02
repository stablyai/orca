// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./MobileBrandIcons', () => ({
  AndroidLogo: () => null,
  IosBrandIcon: () => null
}))

vi.mock('./NetworkInterfacePicker', () => ({
  NetworkInterfacePicker: () => null
}))

vi.mock('../settings/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: () => null
}))

vi.mock('./WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: () => null
}))

import { HeroFlow, type StepIndex } from './MobileHero'
import { MobileHeroPairingStep } from './MobileHeroPairingStep'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

describe('HeroFlow height', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight'
  )

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.textContent?.includes('Step 1 of 2') ? 300 : 520
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    }
  })

  function renderFlow(
    stepIdx: StepIndex,
    overrides: Partial<React.ComponentProps<typeof HeroFlow>> = {}
  ) {
    return render(
      <HeroFlow
        stepIdx={stepIdx}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairingQrError={false}
        relayMintFailure={null}
        onUseLan={vi.fn()}
        onRetryRelay={vi.fn()}
        onCopyRelayDiagnostics={vi.fn()}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        canGeneratePairing
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        customAddresses={[]}
        selectedAddress={undefined}
        selectedAddressIsCustom={false}
        onSelectedAddressChange={vi.fn()}
        onCustomAddressSelect={vi.fn()}
        onCustomAddressRemove={vi.fn()}
        beforeCustomAddressChange={vi.fn().mockResolvedValue(true)}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        {...overrides}
      />
    )
  }

  it('sizes to the active step and updates when the taller pairing step opens', () => {
    const { rerender } = renderFlow(0)
    const viewport = document.querySelector<HTMLElement>('.mp-flow-viewport')
    expect(viewport).toHaveStyle({ height: '300px' })
    expect(screen.getByText('Step 2 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')

    rerender(
      <HeroFlow
        stepIdx={1}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenAndroidInstallGuide={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairingQrError={false}
        relayMintFailure={null}
        onUseLan={vi.fn()}
        onRetryRelay={vi.fn()}
        onCopyRelayDiagnostics={vi.fn()}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        canGeneratePairing
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        customAddresses={[]}
        selectedAddress={undefined}
        selectedAddressIsCustom={false}
        onSelectedAddressChange={vi.fn()}
        onCustomAddressSelect={vi.fn()}
        onCustomAddressRemove={vi.fn()}
        beforeCustomAddressChange={vi.fn().mockResolvedValue(true)}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />
    )

    expect(viewport).toHaveStyle({ height: '520px' })
    expect(screen.getByText('Step 1 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')
  })

  it('opens the APK install guide without duplicating its troubleshooting steps', async () => {
    const user = userEvent.setup()
    const onOpenAndroidInstallGuide = vi.fn()
    renderFlow(0, {
      platform: 'android',
      installCopy: { ctaLabel: 'Download APK', url: 'https://example.com/app-release.apk' },
      onOpenAndroidInstallGuide
    })

    expect(screen.queryByText(/full browser, not an in-app browser/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Install guide' }))
    expect(onOpenAndroidInstallGuide).toHaveBeenCalledOnce()
  })

  it('shows Relay mint failure with no QR and the beta note', () => {
    renderFlow(1, {
      pairQrDataUrl: null,
      relayMintFailure: {
        code: 'relay offline',
        stage: 'create_pairing_relay',
        message: 'relay offline'
      }
    })
    const notice = screen.getByTestId('relay-mint-failure-notice')
    expect(notice).toHaveTextContent('Couldn’t create a Relay pairing code')
    expect(notice).toHaveTextContent('Use LAN')
    expect(screen.getByText('No pairing code available')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate code' })).not.toBeInTheDocument()
    expect(screen.getByText('Orca Relay is in beta.')).toBeInTheDocument()
  })

  it('explains an empty QR frame when no code has been generated yet', () => {
    renderFlow(1, { pairQrDataUrl: null, canGeneratePairing: true })
    expect(screen.getByText('Generate a pairing code to continue')).toBeInTheDocument()
  })

  it('explains an empty QR frame when Relay sign-in is required', () => {
    renderFlow(1, {
      pairQrDataUrl: null,
      canGeneratePairing: false,
      connectionMode: 'automatic'
    })
    expect(screen.getByText('Sign in to create a Relay pairing code')).toBeInTheDocument()
  })

  it('disables Relay recovery immediately and delays visible retry feedback', async () => {
    renderFlow(1, {
      pairLoading: true,
      relayMintFailure: {
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay',
        message: 'Relay pairing invite request failed'
      }
    })
    expect(screen.getByRole('button', { name: 'Retry Relay' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Use LAN' })).toBeEnabled()
    await waitFor(() => expect(screen.getByText(/Creating a new pairing code/)).toBeVisible())
  })

  it('does not offer a futile retry when Relay is unavailable on the desktop', () => {
    renderFlow(1, {
      relayMintFailure: {
        code: 'relay_provider_unavailable',
        stage: 'provider_missing',
        message: 'Orca Relay is not available on this desktop'
      }
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Orca Relay isn’t available on this desktop'
    )
    expect(screen.queryByRole('button', { name: 'Retry Relay' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Use LAN' })).toBeEnabled()
  })

  it('hides the mint-failure notice when a Relay QR is shown', () => {
    renderFlow(1, { pairQrDataUrl: 'data:image/png;base64,qr' })
    expect(screen.queryByTestId('relay-mint-failure-notice')).not.toBeInTheDocument()
  })

  it('renders a pairing QR at its natural integer-scaled bitmap size', () => {
    renderFlow(1, { pairQrDataUrl: 'data:image/png;base64,qr', pairQrSize: 218 })

    const image = screen.getByRole('img', { name: 'Pairing QR' })
    const layout = image.closest('.mp-pairing-layout') as HTMLElement
    expect(layout.style.getPropertyValue('--mp-pairing-qr-image-size')).toBe('218px')
    expect(layout.style.getPropertyValue('--mp-pairing-qr-frame-size')).toBe('238px')
  })

  it('shows an encoder error while keeping the copy fallback enabled', () => {
    renderFlow(1, {
      pairingQrError: true,
      pairingUrl: 'orca://pair?code=copy-fallback'
    })

    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t be rendered as a QR code')
    expect(screen.getByRole('button', { name: /Copy pairing code/ })).toBeEnabled()
  })

  it('moves focus to the pairing-code action after recovery succeeds', () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      relayMintFailure: {
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay',
        message: 'Relay pairing invite request failed'
      },
      onUseLan: vi.fn(),
      onRetryRelay: vi.fn(),
      onCopyRelayDiagnostics: vi.fn(),
      pairLoading: false,
      connectionMode: 'automatic',
      onConnectionModeChange: vi.fn(),
      onRegeneratePairing: vi.fn(),
      canGeneratePairing: true,
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    const { rerender } = render(<MobileHeroPairingStep {...props} />)
    screen.getByRole('button', { name: 'Retry Relay' }).focus()

    rerender(
      <MobileHeroPairingStep
        {...props}
        pairQrDataUrl="data:image/png;base64,qr"
        pairingUrl="orca://pair#ready"
        relayMintFailure={null}
      />
    )

    expect(screen.getByRole('button', { name: 'Copy pairing code' })).toHaveFocus()
  })

  it('keeps focus on a persistent control when an ordinary remint finishes', () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      relayMintFailure: null,
      onUseLan: vi.fn(),
      onRetryRelay: vi.fn(),
      onCopyRelayDiagnostics: vi.fn(),
      pairLoading: true,
      connectionMode: 'local-only',
      onConnectionModeChange: vi.fn(),
      onRegeneratePairing: vi.fn(),
      canGeneratePairing: true,
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    const { rerender } = render(<MobileHeroPairingStep {...props} />)
    const refresh = screen.getByRole('button', { name: 'Refresh network interfaces' })
    refresh.focus()

    rerender(
      <MobileHeroPairingStep
        {...props}
        pairQrDataUrl="data:image/png;base64,qr"
        pairingUrl="orca://pair#ready"
        pairLoading={false}
      />
    )

    expect(refresh).toHaveFocus()
  })

  it('demotes the network address picker to a disclosure on Orca Relay', async () => {
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      relayMintFailure: null,
      onUseLan: vi.fn(),
      onRetryRelay: vi.fn(),
      onCopyRelayDiagnostics: vi.fn(),
      pairLoading: false,
      connectionMode: 'automatic',
      onConnectionModeChange: vi.fn(),
      onRegeneratePairing: vi.fn(),
      canGeneratePairing: true,
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [],
      selectedAddress: undefined,
      selectedAddressIsCustom: false,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    const user = userEvent.setup()
    const { rerender } = render(<MobileHeroPairingStep {...props} />)
    expect(screen.queryByText('Network')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh network interfaces' })).toBeNull()

    // Relay still advertises a LAN endpoint, so the picker must stay reachable.
    await user.click(screen.getByRole('button', { name: /Also use a faster local path/i }))
    expect(screen.getByText('Network')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Refresh network interfaces' })).toBeVisible()
    expect(screen.getByText(/Optional\. Pick the Wi‑Fi or Tailscale address/i)).toBeVisible()

    rerender(<MobileHeroPairingStep {...props} connectionMode="local-only" />)
    expect(screen.getByText('Network')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Also use a faster local path/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh network interfaces' })).toBeVisible()
  })

  it('keeps a custom address visible on Orca Relay', () => {
    const address = 'host.example:6768'
    const props: React.ComponentProps<typeof MobileHeroPairingStep> = {
      pairQrDataUrl: null,
      pairingUrl: null,
      pairingQrError: false,
      relayMintFailure: null,
      onUseLan: vi.fn(),
      onRetryRelay: vi.fn(),
      onCopyRelayDiagnostics: vi.fn(),
      pairLoading: false,
      connectionMode: 'automatic',
      onConnectionModeChange: vi.fn(),
      onRegeneratePairing: vi.fn(),
      canGeneratePairing: true,
      onCopyPairingCode: vi.fn(),
      networkInterfaces: [],
      customAddresses: [address],
      selectedAddress: address,
      selectedAddressIsCustom: true,
      onSelectedAddressChange: vi.fn(),
      onCustomAddressSelect: vi.fn(),
      onCustomAddressRemove: vi.fn(),
      beforeCustomAddressChange: vi.fn().mockResolvedValue(true),
      onRefreshNetworkInterfaces: vi.fn(),
      refreshingNetworkInterfaces: false
    }
    render(<MobileHeroPairingStep {...props} />)
    expect(screen.getByText('Network')).toBeVisible()
    // Why: a trigger here could not collapse the pinned-open row, so it would be
    // a dead control advertising aria-expanded it does not own.
    expect(screen.queryByRole('button', { name: /Also use a faster local path/i })).toBeNull()
  })
})
