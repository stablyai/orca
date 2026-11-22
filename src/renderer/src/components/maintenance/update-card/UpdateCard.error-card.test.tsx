// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { useAppStore } from '../../../store/index'
import { UpdateCard } from './UpdateCard'
import { NotificationCardStack } from '../../notifications/NotificationCardStack'

const openUrl = vi.fn()
const download = vi.fn()
const check = vi.fn()
const quitAndInstall = vi.fn()
const getInstructions = vi.fn()
const showLinuxPackage = vi.fn()
const writeClipboardText = vi.fn()
const relaunch = vi.fn()
const setSettings = vi.fn()

function renderWithInitialStatus(updateStatus: UpdateStatus): RenderResult {
  useAppStore.setState({
    updateStatus,
    updateChangelog: null,
    dismissedUpdateVersion: null,
    updateCardCollapsed: false,
    updateReassuranceSeen: true
  })
  return render(
    <NotificationCardStack>
      <UpdateCard />
    </NotificationCardStack>
  )
}

function renderAfterAvailableStatus(): RenderResult {
  return renderWithInitialStatus({ state: 'available', version: '1.4.200', changelog: null })
}

function mockReducedMotion(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  openUrl.mockReset().mockResolvedValue(undefined)
  download.mockReset().mockResolvedValue(undefined)
  check.mockReset().mockResolvedValue(undefined)
  quitAndInstall.mockReset().mockResolvedValue(undefined)
  showLinuxPackage.mockReset().mockResolvedValue(undefined)
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  relaunch.mockReset().mockResolvedValue(undefined)
  setSettings.mockReset().mockResolvedValue(undefined)
  getInstructions.mockReset().mockResolvedValue({
    ok: true,
    command: 'sudo apt-get install -y /tmp/orca_1.4.200_amd64.deb',
    packageFileName: 'orca_1.4.200_amd64.deb'
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { relaunch },
      settings: { set: setSettings },
      shell: { openUrl },
      ui: { set: vi.fn().mockResolvedValue(undefined), writeClipboardText },
      updater: {
        check,
        dismissNudge: vi.fn(),
        dismissAvailableUpdate: vi.fn().mockResolvedValue(undefined),
        download,
        getLinuxPackageInstallInstructions: getInstructions,
        showLinuxPackage,
        quitAndInstall
      }
    }
  })
  mockReducedMotion(false)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

async function flushActions(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve()
    }
  })
}

describe('UpdateCard Linux package-install recovery', () => {
  it('links unusable package metadata to the release without offering a futile retry', () => {
    const message =
      'The downloaded package metadata could not be verified. Quit Orca before downloading and installing the update from the official release page.'
    renderWithInitialStatus({
      state: 'error',
      message,
      version: '1.4.200',
      retryable: false
    })

    expect(screen.getByText('Update Error')).toBeTruthy()
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.queryByText('Manual Install Required')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry Download' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Download Manually' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/stablyai/orca/releases/tag/v1.4.200')
  })

  it('relaunches once when Enable & Restart is double-clicked', async () => {
    renderAfterAvailableStatus()

    act(() =>
      useAppStore
        .getState()
        .setUpdateStatus({ state: 'error', message: 'net::ERR_HTTP2_PROTOCOL_ERROR' })
    )

    // aria-disabled still dispatches clicks; the handler guard must prevent duplicate relaunch.
    const enable = screen.getByRole('button', { name: 'Enable & Restart' })
    fireEvent.click(enable)

    const pending = screen.getByRole('button', { name: 'Restarting...' })
    expect(pending.getAttribute('aria-disabled')).toBe('true')
    let secondClickDispatched = false
    pending.addEventListener('click', () => {
      secondClickDispatched = true
    })
    fireEvent.click(pending)
    await flushActions()

    expect(secondClickDispatched).toBe(true)

    expect(setSettings).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith({ electronHttp1CompatibilityMode: true })
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})
