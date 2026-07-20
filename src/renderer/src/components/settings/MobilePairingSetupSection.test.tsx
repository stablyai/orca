// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    connectionPathControl: <div data-testid="path-control">path</div>,
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
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        shell: { openUrl: vi.fn().mockResolvedValue(undefined) }
      }
    })
  })

  it('shows connection, address, and generate in a compact flow', () => {
    renderSection()
    expect(screen.getByText('Pair a phone')).toBeVisible()
    expect(screen.getByText('Connection')).toBeVisible()
    expect(screen.getByText('This computer’s address')).toBeVisible()
    expect(screen.getByTestId('path-control')).toBeVisible()
    expect(screen.getByRole('combobox')).toHaveTextContent('100.64.1.20 (tailscale0)')
    expect(screen.getByRole('button', { name: 'Generate QR code' })).toBeVisible()
    expect(screen.getByText(/must be able to reach this address/i)).toBeVisible()
  })

  it('describes address role when Anywhere is selected', () => {
    renderSection({ connectionMode: 'automatic' })
    expect(screen.getByText(/faster direct path when nearby/i)).toBeVisible()
  })

  it('disables generate when sign-in is required', () => {
    // The sign-in explanation lives in the connection panel above, not here, so
    // this section only gates the button rather than repeating the copy.
    renderSection({ canGenerate: false })
    expect(screen.getByRole('button', { name: 'Generate QR code' })).toBeDisabled()
    expect(screen.queryByText(/Sign in above first/i)).toBeNull()
  })

  it('commits an OS interface picked from the list', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: '192.168.1.24 (en0)' }))
    expect(onSelectedAddressChange).toHaveBeenCalledWith('192.168.1.24')
  })

  it('generates a pairing code', async () => {
    const { user, onGenerateQr } = renderSection()
    await user.click(screen.getByRole('button', { name: 'Generate QR code' }))
    expect(onGenerateQr).toHaveBeenCalledOnce()
  })
})
