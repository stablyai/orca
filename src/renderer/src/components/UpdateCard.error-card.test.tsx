// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinuxPackageInstallRecovery } from '../../../shared/types'
import { useAppStore } from '../store'
import { UpdateCard } from './UpdateCard'

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
  reason: 'authentication-agent-unavailable',
  version: '1.4.200'
}

function renderAfterAvailableStatus(): RenderResult {
  useAppStore.setState({
    updateStatus: {
      state: 'available',
      version: '1.4.200',
      changelog: null
    },
    updateChangelog: null,
    dismissedUpdateVersion: null,
    updateCardCollapsed: false,
    updateReassuranceSeen: true
  })
  return render(<UpdateCard />)
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
  openUrl.mockReset()
  download.mockReset()
  check.mockReset()
  quitAndInstall.mockReset().mockResolvedValue(undefined)
  showLinuxPackage.mockReset().mockResolvedValue(undefined)
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  relaunch.mockReset()
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

  it('keeps the blocked-check error collapsed while preserving retry and details', () => {
    const message =
      'Command failed: powershell.exe Get-AuthenticodeSignature -LiteralPath update.exe'
    renderAfterAvailableStatus()

    act(() => useAppStore.getState().setUpdateStatus({ state: 'error', message }))

    expect(screen.getByText('Update Verification Blocked')).toBeTruthy()
    expect(screen.queryByText(message)).toBeNull()
    expect(screen.queryByText(/Windows verifies the installer/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry Download' }))
    expect(download).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide details' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
  })
})

describe('UpdateCard hourly builds', () => {
  it('links a pinned hourly build to its own repo instead of a 404 main-repo tag', () => {
    useAppStore.setState({
      updateStatus: {
        state: 'available',
        version: '1.4.160-hourly.202607281400',
        changelog: null,
        source: 'hourly'
      },
      updateChangelog: null,
      dismissedUpdateVersion: null,
      updateCardCollapsed: false,
      updateReassuranceSeen: true
    })
    render(<UpdateCard />)

    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(openUrl).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca-hourly/releases/tag/v1.4.160-hourly.202607281400'
    )
  })
})

describe('UpdateCard local builds', () => {
  it('does not link local versions to GitHub release downloads', () => {
    useAppStore.setState({
      updateStatus: {
        state: 'available',
        version: '1.4.100-local.1.abc',
        changelog: null,
        source: 'local'
      },
      updateChangelog: null,
      dismissedUpdateVersion: null,
      updateCardCollapsed: false,
      updateReassuranceSeen: true
    })
    render(<UpdateCard />)

    expect(screen.queryByText('Release notes')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(download).toHaveBeenCalledTimes(1)

    act(() =>
      useAppStore.getState().setUpdateStatus({
        state: 'error',
        message: 'signature rejected',
        source: 'local'
      })
    )
    expect(screen.getByText('Local Build Error')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Download Manually' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Choose Another Build' }))
    expect(check).toHaveBeenCalledWith({ localBuild: true })
  })
})

// ── Linux package-install recovery routing ───────────────────────────

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
      message: 'pkexec: no polkit authentication agent found',
      recovery
    })
  )
}

describe('UpdateCard Linux package-install recovery', () => {
  it('routes package-install errors to the recovery card instead of the generic one', () => {
    renderAfterAvailableStatus()

    showPackageRecovery()

    expect(screen.getByText('Automatic Install Failed')).toBeTruthy()
    expect(screen.queryByText('Update Error')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry Download' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy Install Command' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try Automatic Install Again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show Package' })).toBeTruthy()
  })

  it('drives the copy action through the real preload surface', async () => {
    renderAfterAvailableStatus()
    showPackageRecovery()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Command' }))
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(1)
    expect(writeClipboardText).toHaveBeenCalledWith(
      'sudo apt-get install -y /tmp/orca_1.4.200_amd64.deb'
    )
  })

  it('offers the version release fallback once no command can be built', async () => {
    getInstructions.mockResolvedValue({
      ok: false,
      reason: 'no-package-manager',
      message: 'No supported package manager was found.'
    })
    renderAfterAvailableStatus()
    showPackageRecovery()

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Command' }))
    await flushActions()

    fireEvent.click(screen.getByRole('button', { name: 'Download Manually' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/stablyai/orca/releases/tag/v1.4.200')
  })

  it('keeps generic errors on the generic card when no recovery is attached', () => {
    renderAfterAvailableStatus()

    act(() => useAppStore.getState().setUpdateStatus({ state: 'error', message: 'ENOSPC' }))

    expect(screen.getByText('Update Error')).toBeTruthy()
    expect(screen.queryByText('Automatic Install Failed')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Download' }))
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('leaves the HTTP/1.1 compatibility branch untouched', () => {
    renderAfterAvailableStatus()

    act(() =>
      useAppStore
        .getState()
        .setUpdateStatus({ state: 'error', message: 'net::ERR_HTTP2_PROTOCOL_ERROR' })
    )

    expect(screen.getByText('HTTP/2 Download Blocked')).toBeTruthy()
    expect(screen.queryByText('Automatic Install Failed')).toBeNull()
    expect(screen.getByRole('button', { name: 'Enable & Restart' })).toBeTruthy()
  })

  it('relaunches once when Enable & Restart is double-clicked', async () => {
    renderAfterAvailableStatus()

    act(() =>
      useAppStore
        .getState()
        .setUpdateStatus({ state: 'error', message: 'net::ERR_HTTP2_PROTOCOL_ERROR' })
    )

    // Why: the shared card marks the pending action aria-disabled, so the second click still
    // reaches the handler and only its own guard can stop a double relaunch.
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

  it('keeps long diagnostics inside the fixed-width card', () => {
    const { container } = renderAfterAvailableStatus()

    act(() =>
      useAppStore.getState().setUpdateStatus({
        state: 'error',
        message: `pkexec failed ${'overflow-token '.repeat(400)}`,
        recovery: PACKAGE_RECOVERY
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))

    const surface = container.firstElementChild as HTMLElement
    expect(surface.className).toContain('w-[360px]')
    expect(surface.className).toContain('max-w-[calc(100vw-32px)]')
    const detail = container.querySelector('p.font-mono')
    expect(detail?.className).toContain('max-h-20')
    expect(detail?.className).toContain('overflow-auto')
    expect(detail?.className).toContain('break-words')
  })
})

describe('UpdateCard recovery keyboard and motion', () => {
  it('minimizes the recovery card on Escape', () => {
    mockReducedMotion(true)
    renderAfterAvailableStatus()
    showPackageRecovery()

    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' })

    expect(useAppStore.getState().updateCardCollapsed).toBe(true)
    expect(screen.queryByText('Automatic Install Failed')).toBeNull()
  })

  it('plays the exit animation before minimizing when motion is allowed', () => {
    renderAfterAvailableStatus()
    showPackageRecovery()

    const card = screen.getByRole('complementary')
    expect(card.className).toContain('animate-update-card-enter')

    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.getByRole('complementary').className).toContain('animate-update-card-exit')
  })

  it('drops card animation classes under reduced motion', () => {
    mockReducedMotion(true)
    renderAfterAvailableStatus()
    showPackageRecovery()

    const card = screen.getByRole('complementary')
    expect(card.className).not.toContain('animate-update-card-enter')
    expect(card.className).not.toContain('animate-update-card-exit')
  })

  it('activates the recovery primary action with Enter without minimizing', async () => {
    const user = userEvent.setup()
    renderAfterAvailableStatus()
    showPackageRecovery()

    const copyButton = screen.getByRole('button', { name: 'Copy Install Command' })
    copyButton.focus()
    expect(document.activeElement).toBe(copyButton)

    await user.keyboard('{Enter}')
    await flushActions()

    expect(getInstructions).toHaveBeenCalledTimes(1)
    // Why: the card's Escape handler sits on the wrapper and must not swallow action keys.
    expect(useAppStore.getState().updateCardCollapsed).toBe(false)
  })
})
