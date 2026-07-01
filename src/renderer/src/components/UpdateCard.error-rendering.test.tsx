// @vitest-environment happy-dom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UPDATE_ERROR_REASON_SIGNATURE_VERIFICATION } from '../../../shared/updater-error-reasons'
import { useAppStore } from '../store'
import {
  isHttp2ProtocolError,
  shouldShowManualDownloadForUpdateError,
  UpdateCard
} from './UpdateCard'

beforeEach(() => {
  vi.stubGlobal('window', {
    api: {
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl: vi.fn() },
      updater: {
        download: vi.fn().mockResolvedValue(undefined),
        quitAndInstall: vi.fn().mockResolvedValue(undefined),
        dismissNudge: vi.fn().mockResolvedValue(undefined)
      }
    },
    matchMedia: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('HTTP/2 update error detection', () => {
  it('recognizes Electron HTTP/2 protocol failures without matching generic errors', () => {
    expect(isHttp2ProtocolError('net::ERR_HTTP2_PROTOCOL_ERROR')).toBe(true)
    expect(isHttp2ProtocolError('Download failed: HTTP/2 protocol error')).toBe(true)
    expect(isHttp2ProtocolError('Download failed: socket hang up')).toBe(false)
    expect(isHttp2ProtocolError('HTTP proxy authentication failed')).toBe(false)
  })
})

describe('manual update fallback for errors', () => {
  it('suppresses manual download for signature-verification failures', () => {
    expect(
      shouldShowManualDownloadForUpdateError({
        state: 'error',
        message: 'Orca could not verify the update publisher.',
        reason: UPDATE_ERROR_REASON_SIGNATURE_VERIFICATION
      })
    ).toBe(false)
  })

  it('keeps manual download available for ordinary update errors', () => {
    expect(
      shouldShowManualDownloadForUpdateError({
        state: 'error',
        message: 'download failed'
      })
    ).toBe(true)
  })
})

describe('UpdateCard signature-verification error rendering', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    root?.unmount()
    root = null
    container?.remove()
    container = null

    useAppStore.setState({
      updateStatus: { state: 'idle' },
      updateChangelog: null,
      updateUserInitiatedCycle: false,
      dismissedUpdateVersion: null,
      updateCardCollapsed: false
    })
  })

  it('does not render the manual download fallback for signature failures', async () => {
    useAppStore.setState({
      updateStatus: {
        state: 'error',
        message: 'Orca could not verify the update publisher.',
        reason: UPDATE_ERROR_REASON_SIGNATURE_VERIFICATION,
        userInitiated: true
      },
      updateUserInitiatedCycle: true,
      updateCardCollapsed: false
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(UpdateCard))
    })

    const html = container.innerHTML
    expect(html).toContain('Update Verification Failed')
    expect(html).toContain('Re-check')
    expect(html).not.toContain('Download Manually')
  })

  it('renders 100 percent downloading as finalizing instead of stuck download copy', async () => {
    useAppStore.setState({
      updateStatus: { state: 'downloading', percent: 100, version: '1.2.0' },
      updateUserInitiatedCycle: true,
      updateCardCollapsed: false
    })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(createElement(UpdateCard))
    })

    const html = container.innerHTML
    expect(html).toContain('Orca v1.2.0 is being verified.')
    expect(html).toContain('Finalizing update...')
    expect(html).not.toContain('Downloading... 100%')
  })
})
