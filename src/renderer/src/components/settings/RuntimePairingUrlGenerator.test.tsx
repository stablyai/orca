// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listNetworkInterfaces: vi.fn(),
  listRuntimeAccessGrants: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./RuntimeAccessGrantList', () => ({ RuntimeAccessGrantList: () => null }))
vi.mock('./RuntimePairingGeneratorForm', () => ({
  RuntimePairingGeneratorForm: (props: { selectedAddress: string }) => (
    <div data-testid="selected-address">{props.selectedAddress}</div>
  )
}))

import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { runtimePairingLinkCache } from './runtime-pairing-link-state'

describe('RuntimePairingUrlGenerator', () => {
  beforeEach(() => {
    runtimePairingLinkCache.selectedAddress = '100.76.32.125'
    runtimePairingLinkCache.customAddress = ''
    runtimePairingLinkCache.intent = 'another'
    runtimePairingLinkCache.generatedAddress = null
    runtimePairingLinkCache.runtimePairingUrl = null
    runtimePairingLinkCache.webClientUrl = null
    runtimePairingLinkCache.runtimePairingDeviceId = null
    mocks.listNetworkInterfaces.mockReset()
    mocks.listRuntimeAccessGrants.mockReset().mockResolvedValue({ grants: [] })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          listRuntimeAccessGrants: mocks.listRuntimeAccessGrants
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps the cached address while interfaces are loading', async () => {
    let resolveInterfaces!: (value: { interfaces: { name: string; address: string }[] }) => void
    mocks.listNetworkInterfaces.mockReturnValue(
      new Promise((resolve) => {
        resolveInterfaces = resolve
      })
    )

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())
    expect(screen.getByTestId('selected-address')).toHaveTextContent('100.76.32.125')

    resolveInterfaces({
      interfaces: [{ name: 'tailscale0', address: '100.76.32.125' }]
    })
    await waitFor(() =>
      expect(screen.getByTestId('selected-address')).toHaveTextContent('100.76.32.125')
    )
  })
})
