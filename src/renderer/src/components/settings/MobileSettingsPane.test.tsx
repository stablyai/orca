// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  idlePublicTunnelState,
  type PublicTunnelState
} from '../../../../shared/public-tunnel-types'
import { MobileSettingsPane } from './MobileSettingsPane'

type StoreState = {
  settingsSearchQuery: string
  settings: {
    showMobileButton?: boolean
    mobileAutoRestoreFitMs?: number | null
  }
  updateSettings: (patch: Record<string, unknown>) => Promise<void>
  orcaProfileAuthStatus?: { state: string }
}

const mocks = vi.hoisted(() => {
  const holder: { state: StoreState } = {
    state: {
      settingsSearchQuery: '',
      settings: { showMobileButton: true },
      updateSettings: vi.fn(),
      orcaProfileAuthStatus: { state: 'connected' }
    }
  }
  const useAppStore = Object.assign(
    (selector: (state: StoreState) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return {
    holder,
    useAppStore,
    updateSettings: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('../../store', () => ({ useAppStore: mocks.useAppStore }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en' }
}))
vi.mock('./MobilePane', () => ({ MobilePane: () => <div data-testid="mock-mobile-pane" /> }))

const mobile = {
  getPublicTunnelStatus: vi.fn<() => Promise<PublicTunnelState>>(),
  onPublicTunnelStatusChanged: vi.fn(() => () => {}),
  startPublicTunnel: vi.fn<() => Promise<PublicTunnelState>>(),
  stopPublicTunnel: vi.fn<() => Promise<PublicTunnelState>>()
}
const writeClipboardText = vi.fn<() => Promise<void>>()

beforeEach(() => {
  mocks.holder.state = {
    settingsSearchQuery: '',
    settings: { showMobileButton: true },
    updateSettings: mocks.updateSettings,
    orcaProfileAuthStatus: { state: 'connected' }
  }
  mobile.getPublicTunnelStatus.mockResolvedValue(idlePublicTunnelState())
  mobile.onPublicTunnelStatusChanged.mockReturnValue(() => {})
  mobile.startPublicTunnel.mockResolvedValue(idlePublicTunnelState())
  mobile.stopPublicTunnel.mockResolvedValue(idlePublicTunnelState())
  window.api = {
    mobile,
    ui: { writeClipboardText }
  } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MobileSettingsPane', () => {
  it('renders the public tunnel section in Mobile settings', async () => {
    render(<MobileSettingsPane />)

    expect(screen.getByText('Public Tunnel (Cloudflare)')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start public tunnel/i })).toBeInTheDocument()
    })
  })

  it('keeps public tunnel visible when searching for "public tunnel"', async () => {
    mocks.holder.state.settingsSearchQuery = 'public tunnel'
    render(<MobileSettingsPane />)

    expect(screen.getByText('Public Tunnel (Cloudflare)')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start public tunnel/i })).toBeInTheDocument()
    })
  })

  it('keeps public tunnel visible when searching for "cloudflare"', async () => {
    mocks.holder.state.settingsSearchQuery = 'cloudflare'
    render(<MobileSettingsPane />)

    expect(screen.getByText('Public Tunnel (Cloudflare)')).toBeInTheDocument()
  })
})
