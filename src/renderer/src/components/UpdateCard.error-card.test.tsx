// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinuxPackageInstallRecovery, UpdateStatus } from '../../../shared/update-status-types'
import { useAppStore } from '../store'
import { UpdateCard } from './UpdateCard'
import { NotificationCardStack } from './NotificationCardStack'

const openUrl = vi.fn()
const download = vi.fn()
const check = vi.fn()
const quitAndInstall = vi.fn()
const getInstructions = vi.fn()
const showLinuxPackage = vi.fn()
const writeClipboardText = vi.fn()
const relaunch = vi.fn()
const setSettings = vi.fn()

const PACKAGE_RECOVERY: LinuxPackageInstallRecovery = {
  kind: 'linux-package-install',
  packageType: 'deb',
  reason: 'manual-install-required',
  version: '1.4.200'
}

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

describe('UpdateCard Windows signature failures', () => {
  it('does not offer the rejected version as a manual publisher-check bypass', () => {
    const message =
      'New version 1.4.200 is not signed by the application owner: publisherNames: Orca'
    renderAfterAvailableStatus()

    act(() => useAppStore.getState().setUpdateStatus({ state: 'error', message }))

    expect(screen.getByText("Update Wasn't Installed")).toBeTruthy()
    expect(screen.getByText(/Don't install this download/)).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Check official releases' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/stablyai/orca/releases')
    expect(openUrl).not.toHaveBeenCalledWith(expect.stringContaining('/tag/'))
  })
})

async function flushActions(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve()
    }
  })
}

function showPackageRecovery(recovery = PACKAGE_RECOVERY): void {
  act(() =>
    useAppStore.getState().setUpdateStatus({
      state: 'error',
      message: 'Quit Orca before running the system package install command.',
      recovery
    })
  )
}

describe('UpdateCard Linux package-install recovery', () => {
  it('resets command discovery when a newer package cycle replaces the recovery', async () => {
    getInstructions.mockResolvedValueOnce({
      ok: false,
      reason: 'no-package-manager',
      message: 'No supported package manager was found.'
    })
    renderAfterAvailableStatus()
    showPackageRecovery()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Command' }))
    await flushActions()
    expect(screen.queryByRole('button', { name: 'Copy Install Command' })).toBeNull()

    showPackageRecovery({ ...PACKAGE_RECOVERY, version: '1.4.201' })

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Command' }))
    await flushActions()
    expect(getInstructions).toHaveBeenCalledTimes(2)
    expect(writeClipboardText).toHaveBeenCalledTimes(1)
  })

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

describe('UpdateCard recovery keyboard and motion', () => {
  it('minimizes the recovery card on Escape', () => {
    mockReducedMotion(true)
    renderAfterAvailableStatus()
    showPackageRecovery()

    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' })

    expect(useAppStore.getState().updateCardCollapsed).toBe(true)
    expect(screen.queryByText('Manual Install Required')).toBeNull()
  })
})
