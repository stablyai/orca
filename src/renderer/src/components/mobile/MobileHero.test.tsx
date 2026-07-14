// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
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

  function renderFlow(stepIdx: StepIndex) {
    return render(
      <HeroFlow
        stepIdx={stepIdx}
        platform="ios"
        onPlatformChange={vi.fn()}
        installQrUrl={null}
        installCopy={{ ctaLabel: 'Open TestFlight', url: 'https://example.com' }}
        iosChannel="preview"
        onIosChannelChange={vi.fn()}
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        selectedAddress={undefined}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
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
        onOpenInstallUrl={vi.fn()}
        onCopyInstallUrl={vi.fn()}
        pairQrDataUrl={null}
        pairingUrl={null}
        pairLoading={false}
        connectionMode="automatic"
        onConnectionModeChange={vi.fn()}
        onRegeneratePairing={vi.fn()}
        onCopyPairingCode={vi.fn()}
        networkInterfaces={[]}
        selectedAddress={undefined}
        onSelectedAddressChange={vi.fn()}
        onRefreshNetworkInterfaces={vi.fn()}
        refreshingNetworkInterfaces={false}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />
    )

    expect(viewport).toHaveStyle({ height: '520px' })
    expect(screen.getByText('Step 1 of 2').closest('.mp-flow-screen')).toHaveAttribute('inert')
  })
})
