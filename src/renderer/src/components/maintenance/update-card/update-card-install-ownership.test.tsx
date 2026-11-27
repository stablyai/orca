// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { registerUpdaterStatusIpcBridge } from '../../../hooks/ipc-events/native-app/updater-status-ipc-bridge'
import { useAppStore } from '../../../store/index'
import { GeneralUpdateSettingsSection } from '../../settings/updates/GeneralUpdateSettingsSection'
import { TooltipProvider } from '../../ui/tooltip'
import { UpdateCard } from './UpdateCard'

const VERSION = '1.4.280-adhoc.20261127061846'
let emitStatus: (status: UpdateStatus) => void = () => {}
const quitAndInstall = vi.fn(() => Promise.resolve())
const download = vi.fn(() => Promise.resolve())
const unsubs: (() => void)[] = []

beforeEach(() => {
  quitAndInstall.mockClear()
  download.mockClear()
  vi.stubGlobal('api', {
    updater: {
      getStatus: () => new Promise(() => {}),
      getVersion: () => Promise.resolve('1.4.279-adhoc.20261126000000'),
      check: vi.fn(() => Promise.resolve()),
      download,
      quitAndInstall,
      listBuilds: () => new Promise(() => {}),
      onStatus: (callback: (status: UpdateStatus) => void) => {
        emitStatus = callback
        return () => {}
      },
      onClearDismissal: () => () => {}
    },
    settings: { set: vi.fn(() => Promise.resolve()) },
    app: { quit: vi.fn(), relaunch: vi.fn() },
    shell: { openUrl: vi.fn() }
  })
  useAppStore.setState({
    settings: getDefaultSettings('/home/test'),
    updateStatus: { state: 'idle' },
    updateUserInitiatedCycle: false,
    updateCardCollapsed: false,
    dismissedUpdateVersion: null,
    updateReassuranceSeen: true
  })
  registerUpdaterStatusIpcBridge(unsubs)
  render(
    <TooltipProvider>
      <GeneralUpdateSettingsSection />
      <UpdateCard />
    </TooltipProvider>
  )
})

afterEach(() => {
  cleanup()
  unsubs.splice(0).forEach((unsub) => unsub())
  vi.unstubAllGlobals()
})

function emit(status: UpdateStatus): void {
  act(() => emitStatus(status))
}

function offerPinnedBuild(): void {
  emit({ state: 'checking', userInitiated: true })
  emit({ state: 'available', version: VERSION, changelog: null })
}

function finishDownload(): void {
  emit({ state: 'downloading', version: VERSION, percent: 50 })
  emit({ state: 'downloaded', version: VERSION })
}

it('a Settings download waits for Restart even after the card started an earlier attempt', () => {
  offerPinnedBuild()
  fireEvent.click(screen.getByRole('button', { name: 'Update' }))
  emit({ state: 'downloading', version: VERSION, percent: 10 })
  emit({ state: 'error', version: VERSION, message: 'net::ERR_CONNECTION_RESET' })

  offerPinnedBuild()
  fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
  finishDownload()

  expect(quitAndInstall).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy()
})

it("the card's own Update installs as soon as its download finishes", () => {
  offerPinnedBuild()
  fireEvent.click(screen.getByRole('button', { name: 'Update' }))
  finishDownload()

  expect(quitAndInstall).toHaveBeenCalledTimes(1)
})
