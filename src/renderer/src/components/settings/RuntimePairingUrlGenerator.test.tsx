// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listNetworkInterfaces: vi.fn(),
  listRuntimeAccessGrants: vi.fn(),
  getRuntimePairingUrl: vi.fn(),
  isWebSocketReady: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('./RuntimeAccessGrantList', () => ({ RuntimeAccessGrantList: () => null }))
vi.mock('./RuntimePairingGeneratorForm', () => ({
  RuntimePairingGeneratorForm: (props: { selectedAddress: string; onGenerate: () => void }) => (
    <div>
      <div data-testid="selected-address">{props.selectedAddress}</div>
      <button type="button" onClick={props.onGenerate}>
        Generate
      </button>
    </div>
  )
}))

import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { runtimePairingLinkCache } from './runtime-pairing-link-state'

describe('RuntimePairingUrlGenerator', () => {
  beforeEach(() => {
    runtimePairingLinkCache.selectedAddress = '100.76.32.125'
    runtimePairingLinkCache.customAddress = ''
    runtimePairingLinkCache.cloudflareAddress = ''
    runtimePairingLinkCache.intent = 'another'
    runtimePairingLinkCache.generatedAddress = null
    runtimePairingLinkCache.runtimePairingUrl = null
    runtimePairingLinkCache.webClientUrl = null
    runtimePairingLinkCache.runtimePairingDeviceId = null
    mocks.listNetworkInterfaces.mockReset()
    mocks.listRuntimeAccessGrants.mockReset().mockResolvedValue({ grants: [] })
    mocks.isWebSocketReady
      .mockReset()
      .mockResolvedValue({ ready: true, endpoint: 'ws://127.0.0.1:6768' })
    mocks.getRuntimePairingUrl.mockReset().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://127.0.0.1:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'runtime-1'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          listRuntimeAccessGrants: mocks.listRuntimeAccessGrants,
          getRuntimePairingUrl: mocks.getRuntimePairingUrl,
          isWebSocketReady: mocks.isWebSocketReady
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

  // Why: the main process gates the one-way network widen on the declared reach, so dropping it (as the
  // component used to) leaves main guessing from the address string — "This computer only" then widened,
  // and a Custom loopback tunnel front-end would not.
  it.each([
    ['local' as const, '127.0.0.1', 'this-computer'],
    ['another' as const, '100.76.32.125', 'network'],
    ['custom' as const, '127.0.0.1:8443', 'network'],
    ['cloudflare' as const, 'wss://tidy-otter-plum.trycloudflare.com', 'network']
  ])('sends the %s reach with the address', async (intent, address, reach) => {
    runtimePairingLinkCache.intent = intent
    runtimePairingLinkCache.selectedAddress = address
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'tailscale0', address: '100.76.32.125' }]
    })

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())

    screen.getByRole('button', { name: 'Generate' }).click()

    await waitFor(() =>
      expect(mocks.getRuntimePairingUrl).toHaveBeenCalledWith({ address, rotate: true, reach })
    )
  })

  // Preserve wss:// so main does not append the local WebSocket port.
  it('normalizes a pasted https tunnel URL to wss before advertising it', async () => {
    runtimePairingLinkCache.intent = 'cloudflare'
    runtimePairingLinkCache.selectedAddress = 'https://tidy-otter-plum.trycloudflare.com/'
    mocks.listNetworkInterfaces.mockResolvedValue({ interfaces: [] })

    render(<RuntimePairingUrlGenerator />)
    await waitFor(() => expect(mocks.listNetworkInterfaces).toHaveBeenCalledOnce())

    screen.getByRole('button', { name: 'Generate' }).click()

    await waitFor(() =>
      expect(mocks.getRuntimePairingUrl).toHaveBeenCalledWith({
        address: 'wss://tidy-otter-plum.trycloudflare.com',
        rotate: true,
        reach: 'network'
      })
    )
  })
})
