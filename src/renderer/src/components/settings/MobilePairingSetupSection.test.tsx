// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MobilePairingSetupSection } from './MobilePairingSetupSection'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { TooltipProvider } from '../ui/tooltip'

afterEach(() => cleanup())

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

function renderSection(
  overrides: Partial<React.ComponentProps<typeof MobilePairingSetupSection>> = {}
) {
  const onSelectedAddressChange = vi.fn()
  const onRefreshNetworkInterfaces = vi.fn()
  const onGenerateQr = vi.fn()
  const props: React.ComponentProps<typeof MobilePairingSetupSection> = {
    connectionMode: 'local-only',
    relayConnectionControl: null,
    networkInterfaces: [LAN, TAILNET],
    selectedAddress: TAILNET.address,
    onSelectedAddressChange,
    refreshingNetworkInterfaces: false,
    onRefreshNetworkInterfaces,
    loading: false,
    hasQrCode: false,
    onGenerateQr,
    ...overrides
  }
  const user = userEvent.setup()
  const rendered = render(
    <TooltipProvider>
      <MobilePairingSetupSection {...props} />
    </TooltipProvider>
  )
  return { ...rendered, user, onSelectedAddressChange, onGenerateQr }
}

describe('MobilePairingSetupSection', () => {
  it('keeps local settings visible for local-only pairing', () => {
    renderSection()
    expect(screen.getByRole('combobox')).toHaveTextContent('100.64.1.20 (tailscale0)')
    expect(screen.getByText(/connects only through the local network address/i)).toBeVisible()
  })

  it('keeps local settings visible for automatic direct-first pairing', () => {
    renderSection({ connectionMode: 'automatic' })
    expect(screen.getByRole('combobox')).toBeVisible()
    expect(
      screen.getByText(/includes direct access and encrypted Orca Relay fallback/i)
    ).toBeVisible()
  })

  it('commits an OS interface picked from the list', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: '192.168.1.24 (en0)' }))
    expect(onSelectedAddressChange).toHaveBeenCalledWith('192.168.1.24')
  })

  it('generates a pairing code with the selected mode', async () => {
    const { user, onGenerateQr } = renderSection()
    await user.click(screen.getByRole('button', { name: 'Generate QR Code' }))
    expect(onGenerateQr).toHaveBeenCalledOnce()
  })
})
