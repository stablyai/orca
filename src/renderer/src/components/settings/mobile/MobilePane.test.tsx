// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import '../../../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPairedMobileDevicesCacheForTests,
  type PairedMobileDevice as PairedDevice
} from '../../mobile/paired-mobile-devices'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import { decodePairingOffer } from '../../../../../shared/remote-runtime/pairing/pairing'
import { registerMobileHandlers } from '../../../../../main/ipc/mobile'
import { OrcaRuntimeService } from '../../../../../main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../../../../main/runtime/rpc/server/runtime-rpc'
import type { MobilePairingQrResult } from '../../../../../main/runtime/rpc/server/pairing/mobile-pairing-qr'
import { MOBILE_PAIRING_OFFER_TTL_MS } from '../../../../../main/runtime/rpc/server/pairing/pairing-offer-expiry'

type PairedDevicesProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

type StoreState = {
  orcaProfileAuthStatus: { state: 'connected' | 'local' }
  settingsSearchQuery: string
  settings: {
    mobileAutoRestoreFitMs: number | null
    mobilePairingConnectionMode?: MobilePairingConnectionMode
    mobilePairingCustomAddress?: string | null
    mobilePairingCustomAddresses?: string[]
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  recordFeatureInteraction: (feature: string) => void
  fetchOrcaProfileAuthStatus: () => Promise<unknown>
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = { state: {} as StoreState }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return {
    holder,
    useAppStore,
    ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
    latestPairedDevicesProps: null as PairedDevicesProps | null,
    getPairingQR: vi.fn(),
    listDevices: vi.fn(),
    listNetworkInterfaces: vi.fn(),
    revokeDevice: vi.fn(),
    toastError: vi.fn(),
    toastSuccess: vi.fn(),
    updateSettings: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../../store/index', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.ipcHandlers.set(channel, handler)
  },
  shell: { openExternal: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))
vi.mock('./pairing/mobile-pairing-device-polling', () => ({
  useMobilePairingDevicePolling: vi.fn()
}))

// Stub sections to isolate MobilePane’s mode safety, generation gate and persistence.
vi.mock('./pairing/MobilePairingSetupSection', () => ({
  MobilePairingSetupSection: (props: {
    connectionMode: MobilePairingConnectionMode
    canGenerate?: boolean
    loading: boolean
    connectionPathControl: React.ReactNode
    networkInterfaces: { name: string; address: string }[]
    customAddresses: readonly string[]
    selectedAddress: string | undefined
    selectedAddressIsCustom: boolean
    onSelectedAddressChange: (address: string) => void
    onCustomAddressSelect: (address: string) => void
    onCustomAddressRemove: (address: string) => void
    refreshingNetworkInterfaces: boolean
    onRefreshNetworkInterfaces: () => void
    onGenerateQr: () => void
  }) => (
    <div>
      <span data-testid="mode">{props.connectionMode}</span>
      <span data-testid="can-generate">{String(props.canGenerate)}</span>
      <span data-testid="loading">{String(props.loading)}</span>
      <span data-testid="selected-address">{props.selectedAddress ?? 'none'}</span>
      <span data-testid="selected-address-is-custom">{String(props.selectedAddressIsCustom)}</span>
      <span data-testid="custom-addresses">{props.customAddresses.join(',')}</span>
      <span data-testid="refreshing-addresses">{String(props.refreshingNetworkInterfaces)}</span>
      {props.connectionPathControl}
      {/* Mirror real generation gating so wedged loading state remains observable. */}
      <button
        type="button"
        onClick={props.onGenerateQr}
        disabled={props.loading || props.canGenerate === false}
      >
        Generate
      </button>
      <button type="button" onClick={() => props.onCustomAddressSelect('100.126.117.25:6768')}>
        choose-custom-address
      </button>
      <button type="button" onClick={() => props.onCustomAddressRemove('100.126.117.25:6768')}>
        remove-custom-address
      </button>
      <button
        type="button"
        disabled={props.networkInterfaces.length === 0}
        onClick={() => props.onSelectedAddressChange(props.networkInterfaces[0]!.address)}
      >
        choose-discovered-address
      </button>
      <button type="button" onClick={props.onRefreshNetworkInterfaces}>
        refresh-addresses
      </button>
    </div>
  )
}))
vi.mock('./pairing/MobilePairingConnectionOptions', () => ({
  MobilePairingConnectionOptions: (props: {
    onChange: (mode: MobilePairingConnectionMode) => void
  }) => (
    <div>
      <button type="button" onClick={() => props.onChange('automatic')}>
        choose-anywhere
      </button>
      <button type="button" onClick={() => props.onChange('local-only')}>
        choose-local
      </button>
    </div>
  )
}))
vi.mock('./pairing/MobilePairingQrSection', () => ({
  MobilePairingQrSection: (props: {
    qrDataUrl: string | null
    pairingUrl: string | null
    qrError: boolean
  }) => (
    <div>
      <span data-testid="qr">{props.qrDataUrl ?? 'none'}</span>
      <span data-testid="pairing-url">{props.pairingUrl ?? 'none'}</span>
      <span data-testid="qr-error">{String(props.qrError)}</span>
    </div>
  )
}))
vi.mock('./pairing/MobilePairedDevicesSection', () => ({
  MobilePairedDevicesSection: (props: PairedDevicesProps) => {
    mocks.latestPairedDevicesProps = props
    return <div data-testid="paired-devices">{props.devices.map((d) => d.deviceId).join(',')}</div>
  }
}))
vi.mock('./MobileAutoRestoreFitSection', () => ({ MobileAutoRestoreFitSection: () => <div /> }))
vi.mock('../../mobile/WindowsFirewallNotice', () => ({
  WindowsFirewallNotice: (props: { usingRelay?: boolean }) => (
    <div data-testid="firewall-notice">{String(props.usingRelay)}</div>
  )
}))

import { MobilePane } from './MobilePane'

describe('MobilePane pairing connection mode', () => {
  const getPairingQR = mocks.getPairingQR
  const updateSettings = mocks.updateSettings
  const encodePairingQr = vi.fn<(pairingUrl: string) => Promise<MobilePairingQrResult>>()
  let pairingBackend: OrcaRuntimeRpcServer | undefined
  let pairingUserDataPath: string | undefined

  /** Route renderer pairing requests through real IPC handlers and expose the registry for token checks. */
  async function startPairingBackend() {
    pairingUserDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-pane-'))
    pairingBackend = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath: pairingUserDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await pairingBackend.start()
    registerMobileHandlers(pairingBackend, { encodePairingQr })
    const handler = mocks.ipcHandlers.get('mobile:getPairingQR')
    const registry = pairingBackend.getDeviceRegistry()
    if (!handler || !registry) {
      throw new Error('Pairing backend did not initialize')
    }
    const generate = (args: Parameters<typeof window.api.mobile.getPairingQR>[0]) =>
      handler(null, args)
    getPairingQR.mockImplementation(generate)
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingConnectionMode: 'local-only',
      mobilePairingCustomAddress: '100.64.1.20:6768'
    }
    return { registry, generate }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ipcHandlers.clear()
    encodePairingQr.mockReset().mockResolvedValue({
      ok: true,
      qrDataUrl: 'data:image/png;base64,qr',
      qrSize: 218
    })
    _resetPairedMobileDevicesCacheForTests()
    mocks.latestPairedDevicesProps = null
    getPairingQR.mockReset().mockResolvedValue({
      available: true,
      qrDataUrl: 'data:image/png;base64,qr',
      pairingUrl: 'orca://pair',
      endpoint: 'ws://host',
      connectionMode: 'automatic'
    })
    mocks.listDevices.mockReset().mockResolvedValue({ devices: [] })
    mocks.listNetworkInterfaces.mockReset().mockResolvedValue({ interfaces: [] })
    mocks.revokeDevice.mockReset().mockResolvedValue({ revoked: true })
    updateSettings.mockReset().mockResolvedValue(undefined)
    mocks.holder.state = {
      orcaProfileAuthStatus: { state: 'connected' },
      settingsSearchQuery: '',
      settings: { mobileAutoRestoreFitMs: null },
      updateSettings,
      recordFeatureInteraction: vi.fn(),
      fetchOrcaProfileAuthStatus: vi.fn().mockResolvedValue(null)
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        mobile: {
          getPairingQR,
          listDevices: mocks.listDevices,
          listNetworkInterfaces: mocks.listNetworkInterfaces,
          revokeDevice: mocks.revokeDevice
        },
        ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) }
      }
    })
  })

  afterEach(async () => {
    cleanup()
    _resetPairedMobileDevicesCacheForTests()
    document.body.innerHTML = ''
    try {
      await pairingBackend?.stop()
    } finally {
      pairingBackend = undefined
      if (pairingUserDataPath) {
        rmSync(pairingUserDataPath, { recursive: true, force: true })
        pairingUserDataPath = undefined
      }
    }
  })

  it('rotates invalidated credentials through a lost reply, then reuses a successful copy-only offer', async () => {
    const { registry, generate } = await startPairingBackend()
    const user = userEvent.setup()
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).not.toHaveTextContent(/^none$/))
    const first = decodePairingOffer(screen.getByTestId('pairing-url').textContent ?? '')
    expect(first).toMatchObject({ scope: 'mobile', endpoint: 'ws://100.64.1.20:6768' })
    expect(registry.validateToken(first.deviceToken)).toMatchObject({ lastSeenAt: 0 })

    await user.click(screen.getByRole('button', { name: 'choose-custom-address' }))
    expect(screen.getByTestId('selected-address')).toHaveTextContent('100.126.117.25:6768')
    expect(screen.getByTestId('qr')).toHaveTextContent(/^none$/)
    expect(screen.getByTestId('pairing-url')).toHaveTextContent(/^none$/)
    encodePairingQr.mockResolvedValue({ ok: false, reason: 'encoding_failed' })
    getPairingQR.mockImplementationOnce(async (args) => {
      await generate(args)
      throw new Error('Pairing reply lost')
    })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled())
    const lost = registry.getPendingDevice('mobile', MOBILE_PAIRING_OFFER_TTL_MS)!
    expect(lost.token).not.toBe(first.deviceToken)
    expect(registry.validateToken(first.deviceToken)).toBeNull()
    expect(screen.getByTestId('pairing-url')).toHaveTextContent(/^none$/)

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('pairing-url')).not.toHaveTextContent(/^none$/))
    const replacement = decodePairingOffer(screen.getByTestId('pairing-url').textContent ?? '')
    expect(replacement.endpoint).toBe('ws://100.126.117.25:6768')
    expect(replacement.deviceToken).not.toBe(lost.token)
    expect(registry.validateToken(lost.token)).toBeNull()
    expect(registry.validateToken(replacement.deviceToken)).toMatchObject({ lastSeenAt: 0 })
    expect(getPairingQR).toHaveBeenLastCalledWith({
      address: '100.126.117.25:6768',
      connectionMode: 'local-only',
      rotate: true
    })
    expect(screen.getByTestId('qr')).toHaveTextContent(/^none$/)
    expect(screen.getByTestId('qr-error')).toHaveTextContent('true')

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled())
    const refreshed = decodePairingOffer(screen.getByTestId('pairing-url').textContent ?? '')
    expect(refreshed.deviceToken).toBe(replacement.deviceToken)
    expect(registry.validateToken(replacement.deviceToken)).toMatchObject({ lastSeenAt: 0 })
    expect(getPairingQR).toHaveBeenLastCalledWith({
      address: '100.126.117.25:6768',
      connectionMode: 'local-only'
    })
  })

  it('ignores a stale success without consuming a newer address invalidation', async () => {
    const { registry, generate } = await startPairingBackend()
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Wi-Fi', address: '100.64.1.20' }]
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).not.toHaveTextContent(/^none$/))
    const first = decodePairingOffer(screen.getByTestId('pairing-url').textContent ?? '')

    await user.click(screen.getByRole('button', { name: 'choose-custom-address' }))
    const minted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    getPairingQR.mockImplementationOnce(async (args) => {
      const result = await generate(args)
      minted.resolve()
      await release.promise
      return result
    })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await minted.promise
    const stale = registry.getPendingDevice('mobile', MOBILE_PAIRING_OFFER_TTL_MS)!
    expect(stale.token).not.toBe(first.deviceToken)

    await user.click(screen.getByRole('button', { name: 'choose-discovered-address' }))
    await act(async () => release.resolve())
    expect(screen.getByTestId('pairing-url')).toHaveTextContent(/^none$/)
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('pairing-url')).not.toHaveTextContent(/^none$/))
    const current = decodePairingOffer(screen.getByTestId('pairing-url').textContent ?? '')
    expect(current.deviceToken).not.toBe(stale.token)
    expect(registry.validateToken(stale.token)).toBeNull()
    expect(registry.validateToken(current.deviceToken)).toMatchObject({ lastSeenAt: 0 })
    expect(getPairingQR).toHaveBeenLastCalledWith({
      address: '100.64.1.20',
      connectionMode: 'local-only',
      rotate: true
    })
  })

  it('drops loading after switching path mid-generate', async () => {
    const user = userEvent.setup()
    getPairingQR.mockImplementationOnce(() => new Promise(() => {}))
    render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(getPairingQR).toHaveBeenCalledWith({ connectionMode: 'automatic' }))
    expect(screen.getByTestId('loading')).toHaveTextContent('true')

    // Switching modes must clear the old mint’s loading flag so the new path can generate.
    await user.click(screen.getByRole('button', { name: 'choose-local' }))
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByRole('button', { name: 'Generate' })).toBeEnabled()
  })

  it('clears a shown QR when another window changes the saved path', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<MobilePane />)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('base64,qr'))

    // Model cross-window persistence bypassing changeConnectionMode.
    mocks.holder.state.settings = {
      mobileAutoRestoreFitMs: null,
      mobilePairingConnectionMode: 'local-only'
    }
    rerender(<MobilePane />)

    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('local-only'))
    expect(screen.getByTestId('qr')).toHaveTextContent('none')
  })

  it('copies useful Relay diagnostics without disclosing the selected address or local interfaces', async () => {
    mocks.holder.state.settings.mobilePairingCustomAddress = '100.126.117.25:6768'
    mocks.listNetworkInterfaces.mockResolvedValue({
      interfaces: [{ name: 'Wi-Fi', address: '192.168.1.24' }]
    })
    mocks.getPairingQR.mockResolvedValue({
      available: false,
      reason: 'relay_mint_failed',
      relayFailure: {
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay',
        message: 'Relay pairing invite request failed'
      }
    })
    const user = userEvent.setup()
    render(<MobilePane />)
    expect(screen.getByTestId('selected-address')).toHaveTextContent('100.126.117.25:6768')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await user.click(await screen.findByRole('button', { name: 'Copy diagnostics' }))

    const writeClipboardText = vi.mocked(window.api.ui.writeClipboardText)
    await waitFor(() =>
      expect(writeClipboardText).toHaveBeenCalledWith(
        expect.stringContaining('"mobile_pairing_relay_failure"')
      )
    )
    const copied = writeClipboardText.mock.calls[0]![0]
    const diagnostics = JSON.parse(copied)
    expect(diagnostics).toMatchObject({
      kind: 'mobile_pairing_relay_failure',
      preferredConnectionMode: 'automatic',
      failure: {
        code: 'relay_mint_failed',
        stage: 'create_pairing_relay'
      }
    })
    expect(diagnostics).not.toHaveProperty('selectedAddress')
    expect(copied).not.toContain('100.126.117.25')
    expect(copied).not.toContain('192.168.1.24')
  })
})
