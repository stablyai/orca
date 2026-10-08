// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

vi.mock('./GeneralRemoteServerUpdates', () => ({ GeneralRemoteServerUpdates: () => null }))
vi.mock('./ReleaseChannelSection', () => ({ ReleaseChannelSection: () => null }))

const quitAndInstall = vi.fn()

beforeEach(() => {
  quitAndInstall.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({
    updateStatus: { state: 'available', version: '1.4.200', changelog: null }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: {
        check: vi.fn(),
        download: vi.fn(),
        quitAndInstall,
        getVersion: vi.fn().mockResolvedValue('1.4.199')
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ updateStatus: { state: 'idle' } })
})

it('describes the available action as a download', () => {
  render(<GeneralUpdateSettingsSection />)

  expect(screen.getByRole('button', { name: 'Download Update (1.4.200)' })).toBeTruthy()
  expect(screen.getByText(/is available\. Click "Download Update" to download it\./)).toBeTruthy()
  expect(screen.queryByText(/download and install it/)).toBeNull()
})

it('retries installation from the settings panel when a staged update is blocked', () => {
  useAppStore.setState({
    updateStatus: {
      state: 'error',
      version: '1.4.200',
      message: 'Close the other Orca instances before installing this update.',
      retryAction: 'install'
    }
  })
  render(<GeneralUpdateSettingsSection />)

  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
  expect(quitAndInstall).toHaveBeenCalledTimes(1)
})

it.each([undefined, false] as const)(
  'does not offer install retry without an install action or when retry is refused (%s)',
  (retryable) => {
    useAppStore.setState({
      updateStatus: {
        state: 'error',
        version: '1.4.200',
        message: 'Update failed.',
        ...(retryable === false ? { retryAction: 'install', retryable } : {})
      }
    })
    render(<GeneralUpdateSettingsSection />)

    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull()
    expect(quitAndInstall).not.toHaveBeenCalled()
  }
)
