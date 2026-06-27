// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MobileNetworkInterfaceSection } from './MobileNetworkInterfaceSection'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { TooltipProvider } from '../ui/tooltip'

// Why: Radix Popover portals its content to <body> and does not always unmount
// it synchronously when the test's container is torn down, so multiple
// popover-triggers can leak between tests. Forcing cleanup restores the DOM
// to the empty state before the next render.
afterEach(() => {
  cleanup()
})

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const TAILNET: MobileNetworkInterface = { name: 'tailscale0', address: '100.64.1.20' }

function renderSection(
  overrides: Partial<React.ComponentProps<typeof MobileNetworkInterfaceSection>> = {}
) {
  const onSelectedAddressChange = vi.fn()
  const onRefreshNetworkInterfaces = vi.fn()
  const onGenerateQr = vi.fn()
  const props: React.ComponentProps<typeof MobileNetworkInterfaceSection> = {
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
  const utils = render(
    <TooltipProvider>
      <MobileNetworkInterfaceSection {...props} />
    </TooltipProvider>
  )
  return { ...utils, user, onSelectedAddressChange, onRefreshNetworkInterfaces, onGenerateQr }
}

describe('MobileNetworkInterfaceSection', () => {
  it('renders the trigger with the currently selected address', () => {
    renderSection()
    expect(screen.getByRole('combobox')).toHaveTextContent('100.64.1.20 (tailscale0)')
  })

  it('lets the user type a custom address and confirms via the Use row', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    const input = screen.getByPlaceholderText(/search or type/i)
    await user.type(input, 'my-mac.tail-abcd.ts.net')
    await user.click(screen.getByRole('option', { name: /Use "my-mac\.tail-abcd\.ts\.net"/ }))
    expect(onSelectedAddressChange).toHaveBeenCalledWith('my-mac.tail-abcd.ts.net')
  })

  it('shows an inline error and no Use row when the query is invalid', async () => {
    const { user } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.type(screen.getByPlaceholderText(/search or type/i), 'not an address')
    expect(
      screen.getByText(/Enter an IPv4 address or Tailscale MagicDNS hostname/i)
    ).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Use / })).not.toBeInTheDocument()
  })

  it('suppresses the Use row when the typed address matches an existing interface', async () => {
    const { user } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.type(screen.getByPlaceholderText(/search or type/i), '192.168.1.24')
    expect(screen.getByRole('option', { name: '192.168.1.24 (en0)' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Use "192\.168\.1\.24"/ })).not.toBeInTheDocument()
  })

  it('renders the (custom) label on the trigger after a custom selection', () => {
    renderSection({ selectedAddress: 'my-mac.tail-abcd.ts.net' })
    expect(screen.getByRole('combobox')).toHaveTextContent('my-mac.tail-abcd.ts.net (custom)')
  })

  it('shows No interfaces found when the list is empty', () => {
    renderSection({ networkInterfaces: [], selectedAddress: undefined })
    expect(screen.getByRole('combobox')).toHaveTextContent(/no interfaces found/i)
  })
})
