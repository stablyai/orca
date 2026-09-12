// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

type StoreState = {
  settings: {
    mobilePairingCustomAddress?: string | null
    mobilePairingCustomAddresses?: string[]
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  return {
    holder,
    useAppStore: (selector: (state: StoreState) => unknown) => selector(holder.state)
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))

import { useMobilePairingAddressPreference } from './use-mobile-pairing-address-preference'

const LAN: MobileNetworkInterface = { name: 'en0', address: '192.168.1.24' }
const OTHER: MobileNetworkInterface = { name: 'en1', address: '10.0.0.5' }
const EXTERNAL_SWITCH: MobileNetworkInterface = {
  name: 'vEthernet (Lab)',
  address: '192.168.1.30',
  hasDefaultRoute: true
}
const BRIDGE: MobileNetworkInterface = { name: 'docker0', address: '172.17.0.1' }

function renderPreference(networkInterfaces: readonly MobileNetworkInterface[] = []) {
  mocks.holder.state = {
    settings: {},
    updateSettings: vi.fn().mockResolvedValue(undefined)
  }
  const onSelectionInvalidated = vi.fn()
  const { result } = renderHook(() =>
    useMobilePairingAddressPreference({
      networkInterfaces,
      onSelectionInvalidated
    })
  )
  return { result, onSelectionInvalidated }
}

afterEach(() => cleanup())

describe('useMobilePairingAddressPreference', () => {
  it('does not invalidate the offer on the first address resolution', () => {
    // Why: the renderer's first pick matches the default main already minted
    // with, so invalidating there would drop a QR that is still correct.
    const { result, onSelectionInvalidated } = renderPreference()

    act(() => result.current.selectAddressAfterRefresh([LAN]))

    expect(result.current.selectedAddress).toBe(LAN.address)
    expect(onSelectionInvalidated).not.toHaveBeenCalled()
  })

  it('invalidates when a later refresh moves off the resolved address', () => {
    const { result, onSelectionInvalidated } = renderPreference()

    act(() => result.current.selectAddressAfterRefresh([LAN]))
    act(() => result.current.selectAddressAfterRefresh([OTHER]))

    expect(result.current.selectedAddress).toBe(OTHER.address)
    expect(onSelectionInvalidated).toHaveBeenCalledExactlyOnceWith({
      address: OTHER.address,
      source: 'refresh'
    })
  })

  it('invalidates when discovery stops reporting the resolved address', () => {
    const { result, onSelectionInvalidated } = renderPreference()

    act(() => result.current.selectAddressAfterRefresh([LAN]))
    act(() => result.current.selectAddressAfterRefresh([]))

    expect(result.current.selectedAddress).toBeUndefined()
    expect(onSelectionInvalidated).toHaveBeenCalledExactlyOnceWith({
      address: undefined,
      source: 'refresh'
    })
  })

  it('invalidates an automatic vEthernet selection when route evidence becomes ambiguous', () => {
    const { result, onSelectionInvalidated } = renderPreference()

    act(() => result.current.selectAddressAfterRefresh([EXTERNAL_SWITCH]))
    act(() =>
      result.current.selectAddressAfterRefresh([{ ...EXTERNAL_SWITCH, hasDefaultRoute: undefined }])
    )

    expect(result.current.selectedAddress).toBeUndefined()
    expect(onSelectionInvalidated).toHaveBeenCalledExactlyOnceWith({
      address: undefined,
      source: 'refresh'
    })
  })

  it('keeps an explicitly selected bridge across refreshes', () => {
    const { result, onSelectionInvalidated } = renderPreference([LAN, BRIDGE])

    act(() => result.current.selectAddressAfterRefresh([LAN, BRIDGE]))
    act(() => result.current.selectAddress(BRIDGE.address))
    act(() => result.current.selectAddressAfterRefresh([LAN, BRIDGE]))
    act(() => result.current.selectAddressAfterRefresh([]))

    expect(result.current.selectedAddress).toBe(BRIDGE.address)
    expect(result.current.selectedAddressIsCustom).toBe(false)
    expect(onSelectionInvalidated).toHaveBeenCalledExactlyOnceWith({
      address: BRIDGE.address,
      source: 'user'
    })
  })
})
