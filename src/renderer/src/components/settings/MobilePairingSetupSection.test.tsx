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
  const onCustomAddressSelect = vi.fn()
  const onCustomAddressRemove = vi.fn()
  const onRefreshNetworkInterfaces = vi.fn()
  const onGenerateQr = vi.fn()
  const props: React.ComponentProps<typeof MobilePairingSetupSection> = {
    connectionMode: 'local-only',
    connectionPathControl: <div data-testid="path-control">path</div>,
    networkInterfaces: [LAN, TAILNET],
    customAddresses: [],
    selectedAddress: TAILNET.address,
    selectedAddressIsCustom: false,
    onSelectedAddressChange,
    onCustomAddressSelect,
    onCustomAddressRemove,
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
  return {
    ...rendered,
    user,
    props,
    onSelectedAddressChange,
    onCustomAddressSelect,
    onCustomAddressRemove,
    onGenerateQr
  }
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

  it('explains the direct address when Orca Relay is selected', () => {
    renderSection({ connectionMode: 'automatic' })
    expect(screen.getByText('This computer’s address')).toBeVisible()
    expect(screen.getByRole('combobox')).toBeVisible()
    expect(screen.getByText(/faster direct path when nearby/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Generate QR code' })).toBeEnabled()
  })

  it('can move retry recovery into the persistent failure notice', () => {
    renderSection({ showGenerateAction: false })
    expect(screen.queryByRole('button', { name: 'Generate QR code' })).toBeNull()
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

  it('lists and removes saved custom addresses without selecting them', async () => {
    const first = 'first.example:6768'
    const second = 'second.example:6768'
    const { user, onSelectedAddressChange, onCustomAddressSelect, onCustomAddressRemove } =
      renderSection({ customAddresses: [first, second] })

    await user.click(screen.getByRole('combobox'))
    expect(screen.getByText('Custom')).toBeVisible()
    expect(screen.getByRole('option', { name: `${first} (custom)` })).toBeVisible()
    expect(screen.getByRole('option', { name: `${second} (custom)` })).toBeVisible()
    const addOption = screen.getByRole('option', { name: 'Add custom address…' })
    expect(
      screen
        .getByRole('option', { name: `${second} (custom)` })
        .compareDocumentPosition(addOption) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    const remove = screen.getByRole('button', { name: `Remove ${first}` })
    remove.focus()
    expect(remove).toHaveFocus()
    await user.click(remove)

    expect(onCustomAddressRemove).toHaveBeenCalledWith(first)
    expect(onCustomAddressSelect).not.toHaveBeenCalled()
    expect(onSelectedAddressChange).not.toHaveBeenCalled()
  })

  it('restores list focus after removing a custom address with the keyboard', async () => {
    const address = 'first.example:6768'
    const { user, props, rerender, onCustomAddressSelect } = renderSection({
      customAddresses: [address]
    })

    await user.click(screen.getByRole('combobox'))
    const remove = screen.getByRole('button', { name: `Remove ${address}` })
    remove.focus()
    await user.keyboard('{Enter}')
    rerender(
      <TooltipProvider>
        <MobilePairingSetupSection {...props} customAddresses={[]} />
      </TooltipProvider>
    )

    expect(screen.getByRole('listbox', { name: 'Network address to advertise' })).toHaveFocus()
    expect(onCustomAddressSelect).not.toHaveBeenCalled()
  })

  it('selects a saved custom address through the custom path', async () => {
    const address = '100.64.1.20'
    const { user, onSelectedAddressChange, onCustomAddressSelect } = renderSection({
      customAddresses: [address],
      selectedAddressIsCustom: true
    })

    await user.click(screen.getByRole('combobox'))
    const customOption = screen.getByRole('option', { name: `${address} (custom)` })
    expect(customOption).toHaveAttribute('data-current', 'true')
    await user.click(customOption)

    expect(onCustomAddressSelect).toHaveBeenCalledWith(address)
    expect(onSelectedAddressChange).not.toHaveBeenCalled()
  })

  it('keeps keyboard selection working with removable custom rows', async () => {
    const address = 'first.example:6768'
    const { user, onCustomAddressSelect } = renderSection({ customAddresses: [address] })

    const trigger = screen.getByRole('combobox')
    await user.click(trigger)
    const list = screen.getByRole('listbox', { name: 'Network address to advertise' })
    expect(list).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-controls', list.id)
    const selectedOption = screen.getByRole('option', { name: '100.64.1.20 (tailscale0)' })
    await vi.waitFor(() => expect(list).toHaveAttribute('aria-activedescendant', selectedOption.id))
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onCustomAddressSelect).toHaveBeenCalledWith(address)
  })

  it('supports prefix typeahead across custom addresses', async () => {
    const address = 'zebra.example:6768'
    const { user, onCustomAddressSelect } = renderSection({
      customAddresses: ['alpha.example:6768', address]
    })

    await user.click(screen.getByRole('combobox'))
    await user.keyboard('z')
    const list = screen.getByRole('listbox', { name: 'Network address to advertise' })
    const customOption = screen.getByRole('option', { name: `${address} (custom)` })
    await vi.waitFor(() => expect(list).toHaveAttribute('aria-activedescendant', customOption.id))
    await user.keyboard('{Enter}')

    expect(onCustomAddressSelect).toHaveBeenCalledWith(address)
  })

  it('selects the highlighted custom address with Space', async () => {
    const address = 'first.example:6768'
    const { user, onCustomAddressSelect, onCustomAddressRemove } = renderSection({
      customAddresses: [address]
    })

    await user.click(screen.getByRole('combobox'))
    await user.keyboard('{ArrowDown} ')

    expect(onCustomAddressSelect).toHaveBeenCalledWith(address)
    expect(onCustomAddressRemove).not.toHaveBeenCalled()
  })

  it('generates a pairing code', async () => {
    const { user, onGenerateQr } = renderSection()
    await user.click(screen.getByRole('button', { name: 'Generate QR code' }))
    expect(onGenerateQr).toHaveBeenCalledOnce()
  })
})
