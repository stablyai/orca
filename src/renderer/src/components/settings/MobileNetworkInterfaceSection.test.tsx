// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import React from 'react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MobileNetworkInterfaceSection } from './MobileNetworkInterfaceSection'
import type { MobileNetworkInterface } from './mobile-network-interface-selection'
import { TooltipProvider } from '../ui/tooltip'

// Why: Radix Select/Dialog portal their content to <body> and don't always
// unmount synchronously when the test container tears down, so content can
// leak between tests. Forcing cleanup restores the empty DOM before each render.
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

  it('renders the (custom) label on the trigger when the selection is a manual address', () => {
    renderSection({ selectedAddress: 'my-mac.tail-abcd.ts.net' })
    expect(screen.getByRole('combobox')).toHaveTextContent('my-mac.tail-abcd.ts.net (custom)')
  })

  it('commits an OS interface picked from the list', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: '192.168.1.24 (en0)' }))
    expect(onSelectedAddressChange).toHaveBeenCalledWith('192.168.1.24')
  })

  it('opens the custom-address dialog from the Add custom address row', async () => {
    const { user } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /add custom address/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Address')).toBeInTheDocument()
  })

  it('confirms a valid custom address typed into the dialog', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /add custom address/i }))
    await user.type(screen.getByLabelText('Address'), 'my-mac.tail-abcd.ts.net')
    await user.click(screen.getByRole('button', { name: /use address/i }))
    expect(onSelectedAddressChange).toHaveBeenCalledWith('my-mac.tail-abcd.ts.net')
  })

  it('disables the confirm button while the typed address is invalid', async () => {
    const { user, onSelectedAddressChange } = renderSection()
    await user.click(screen.getByRole('combobox'))
    await user.click(screen.getByRole('option', { name: /add custom address/i }))
    await user.type(screen.getByLabelText('Address'), 'not an address')
    expect(screen.getByRole('button', { name: /use address/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /use address/i }))
    expect(onSelectedAddressChange).not.toHaveBeenCalled()
  })

  it('shows No interfaces found when the list is empty', () => {
    renderSection({ networkInterfaces: [], selectedAddress: undefined })
    expect(screen.getByRole('combobox')).toHaveTextContent(/no interfaces found/i)
  })
})
