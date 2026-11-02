// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  idlePublicTunnelState,
  type PublicTunnelState
} from '../../../../shared/public-tunnel-types'
import { RuntimePublicTunnelSection } from './RuntimePublicTunnelSection'

const remoteUrl =
  'https://orca-demo.trycloudflare.com/remote#pairing=eyJ2IjoyfQ%3D%3D'

function connectedState(): PublicTunnelState {
  return {
    ...idlePublicTunnelState(),
    status: 'connected',
    publicUrl: 'https://orca-demo.trycloudflare.com',
    remoteUrl,
    webClientUrl: 'https://orca-demo.trycloudflare.com/',
    pairingUrl: 'orca://pair?code=eyJ2IjoyfQ',
    deviceId: 'device-1',
    qrDataUrl: 'data:image/png;base64,qr',
    qrSize: 168,
    startedAt: Date.now()
  }
}

const mobile = {
  getPublicTunnelStatus: vi.fn<() => Promise<PublicTunnelState>>(),
  onPublicTunnelStatusChanged: vi.fn(() => () => {}),
  startPublicTunnel: vi.fn<() => Promise<PublicTunnelState>>(),
  stopPublicTunnel: vi.fn<() => Promise<PublicTunnelState>>()
}
const writeClipboardText = vi.fn<() => Promise<void>>()

beforeEach(() => {
  mobile.getPublicTunnelStatus.mockResolvedValue(idlePublicTunnelState())
  mobile.onPublicTunnelStatusChanged.mockReturnValue(() => {})
  mobile.startPublicTunnel.mockResolvedValue(connectedState())
  mobile.stopPublicTunnel.mockResolvedValue(idlePublicTunnelState())
  writeClipboardText.mockResolvedValue(undefined)
  window.api = {
    mobile,
    ui: { writeClipboardText }
  } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RuntimePublicTunnelSection', () => {
  it('starts the tunnel and renders the QR plus mobile link', async () => {
    render(<RuntimePublicTunnelSection />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start public tunnel/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /start public tunnel/i }))

    await waitFor(() => {
      expect(mobile.startPublicTunnel).toHaveBeenCalledWith({ rotate: false })
    })
    expect(await screen.findByAltText(/scan to open the mobile remote shell/i)).toBeTruthy()
    expect(screen.getByDisplayValue(remoteUrl)).toBeTruthy()
    expect(screen.getByText(/public link is live/i)).toBeTruthy()
  })

  it('copies the mobile link from the connected state', async () => {
    mobile.getPublicTunnelStatus.mockResolvedValue(connectedState())
    render(<RuntimePublicTunnelSection />)

    const copyButton = await screen.findByRole('button', { name: /copy mobile link/i })
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(writeClipboardText).toHaveBeenCalledWith(remoteUrl)
    })
  })
})
