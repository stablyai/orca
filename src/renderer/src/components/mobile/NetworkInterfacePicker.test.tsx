// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NetworkInterfacePicker } from './NetworkInterfacePicker'

afterEach(cleanup)

const noop = vi.fn()

function renderPicker(props: {
  networkInterfaces?: { name: string; address: string }[]
  customAddresses?: string[]
  selectedAddress?: string
}): void {
  render(
    <NetworkInterfacePicker
      networkInterfaces={props.networkInterfaces ?? []}
      customAddresses={props.customAddresses ?? []}
      selectedAddress={props.selectedAddress}
      selectedAddressIsCustom={false}
      onSelectedAddressChange={noop}
      onCustomAddressSelect={noop}
      onCustomAddressRemove={noop}
    />
  )
}

describe('NetworkInterfacePicker', () => {
  // Why: a bridge-only host auto-advertises nothing, so the trigger has no selection to show while the
  // bridge is still listed inside. Claiming "No interfaces found" there contradicts the list itself.
  it('does not claim there are no interfaces when unselected options exist', () => {
    renderPicker({ networkInterfaces: [{ name: 'docker0', address: '172.17.0.1' }] })

    expect(screen.getByRole('combobox').textContent).toContain('No address selected')
  })

  it('reports an empty interface list when there is genuinely nothing to pick', () => {
    renderPicker({})

    expect(screen.getByRole('combobox').textContent).toContain('No interfaces found')
  })

  it('shows the selected interface instead of any placeholder', () => {
    renderPicker({
      networkInterfaces: [{ name: 'en0', address: '192.168.1.24' }],
      selectedAddress: '192.168.1.24'
    })

    expect(screen.getByRole('combobox').textContent).toContain('192.168.1.24 (en0)')
  })
})
