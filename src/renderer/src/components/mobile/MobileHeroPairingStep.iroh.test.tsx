// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import type { ComponentProps } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileHeroPairingStep } from './MobileHeroPairingStep'

vi.mock('@/i18n/i18n', () => ({
  i18n: {},
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('react-i18next', () => ({ Trans: () => null }))
vi.mock('./NetworkInterfacePicker', () => ({ NetworkInterfacePicker: () => null }))
vi.mock('../settings/mobile/pairing/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: () => null
}))
vi.mock('../settings/mobile/pairing/MobileRelayBetaNotice', () => ({
  MobileRelayBetaNotice: () => null
}))
vi.mock('../machine-identity/MachineNameField', () => ({ MachineNameField: () => null }))
vi.mock('./WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: () => <div data-testid="windows-firewall-notice" />
}))

afterEach(cleanup)

function renderPairingStep(overrides: Partial<ComponentProps<typeof MobileHeroPairingStep>>) {
  render(
    <MobileHeroPairingStep
      pairQrDataUrl="data:image/png;base64,qr"
      pairingUrl="orca://pair#iroh"
      pairingQrError={false}
      relayMintFailure={null}
      onUseLan={vi.fn()}
      onRetryRelay={vi.fn()}
      onCopyRelayDiagnostics={vi.fn()}
      pairLoading={false}
      connectionMode="iroh"
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
      {...overrides}
    />
  )
}

describe('MobileHeroPairingStep Iroh', () => {
  it.each([undefined, 'host.example:6768'])(
    'keeps Iroh pairing usable without address controls or TCP firewall repair (address: %s)',
    (selectedAddress) => {
      renderPairingStep({
        selectedAddress,
        selectedAddressIsCustom: selectedAddress != null,
        customAddresses: selectedAddress ? [selectedAddress] : []
      })

      expect(screen.queryByRole('button', { name: 'Refresh network interfaces' })).toBeNull()
      expect(screen.queryByRole('button', { name: /Also use a faster local path/i })).toBeNull()
      expect(screen.queryByTestId('windows-firewall-notice')).toBeNull()
      expect(screen.getByRole('button', { name: 'Copy pairing code' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Regenerate code' })).toBeEnabled()
    }
  )

  it.each(['automatic', 'local-only'] as const)(
    'retains TCP firewall guidance for %s pairing',
    (connectionMode) => {
      renderPairingStep({ connectionMode })
      expect(screen.getByTestId('windows-firewall-notice')).toBeInTheDocument()
    }
  )
})
