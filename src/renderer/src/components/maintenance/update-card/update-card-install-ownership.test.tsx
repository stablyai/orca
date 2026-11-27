// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  UpdateDownloadOptions,
  UpdateStatus
} from '../../../../../shared/updater/update-status-types'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { registerUpdaterStatusIpcBridge } from '../../../hooks/ipc-events/native-app/updater-status-ipc-bridge'
import { useAppStore } from '../../../store/index'
import { GeneralUpdateSettingsSection } from '../../settings/updates/GeneralUpdateSettingsSection'
import { TooltipProvider } from '../../ui/tooltip'
import { UpdateCard } from './UpdateCard'

const VERSION = '1.4.280-adhoc.20261127061846'
let emitStatus: (status: UpdateStatus) => void = () => {}
const quitAndInstall = vi.fn(() => Promise.resolve())
const download = vi.fn((_options?: UpdateDownloadOptions) => Promise.resolve())
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

it('only the card Update asks main to install when done; the renderer never installs on its own', () => {
  offerPinnedBuild()
  fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
  expect(download).toHaveBeenLastCalledWith()
  fireEvent.click(screen.getByRole('button', { name: 'Update' }))
  expect(download).toHaveBeenLastCalledWith({ installWhenDownloaded: true })

  finishDownload()
  expect(quitAndInstall).not.toHaveBeenCalled()
})
