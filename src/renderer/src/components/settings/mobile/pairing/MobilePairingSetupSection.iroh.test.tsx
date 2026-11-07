// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../../../ui/tooltip'
import { MobilePairingSetupSection } from './MobilePairingSetupSection'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

it('allows Iroh pairing without showing or requiring an address even when search pins it open', () => {
  render(
    <TooltipProvider>
      <MobilePairingSetupSection
        connectionMode="iroh"
        addressDisclosureForcedOpen
        connectionPathControl={<div />}
        networkInterfaces={[{ name: 'Wi-Fi', address: '192.168.1.24' }]}
        customAddresses={[]}
        selectedAddress={undefined}
        selectedAddressIsCustom={false}
        onSelectedAddressChange={vi.fn()}
        onCustomAddressSelect={vi.fn()}
        onCustomAddressRemove={vi.fn()}
        refreshingNetworkInterfaces={false}
        onRefreshNetworkInterfaces={vi.fn()}
        loading={false}
        hasQrCode={false}
        onGenerateQr={vi.fn()}
      />
    </TooltipProvider>
  )

  expect(screen.queryByRole('combobox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh network interfaces' })).toBeNull()
  expect(screen.queryByRole('button', { name: /Also use a faster local path/i })).toBeNull()
  expect(screen.getByRole('button', { name: 'Generate QR code' })).toBeEnabled()
})
