// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { UpdateCard } from './UpdateCard'

const openUrl = vi.fn()
const download = vi.fn()

function renderAfterAvailableStatus(): void {
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
  render(<UpdateCard />)
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  openUrl.mockReset()
  download.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { relaunch: vi.fn() },
      settings: { set: vi.fn().mockResolvedValue(undefined) },
      shell: { openUrl },
      ui: { set: vi.fn().mockResolvedValue(undefined) },
      updater: {
        check: vi.fn(),
        dismissNudge: vi.fn(),
        download,
        quitAndInstall: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })
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
