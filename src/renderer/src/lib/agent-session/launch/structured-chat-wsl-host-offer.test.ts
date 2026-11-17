// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostAddResult } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

const mocks = vi.hoisted(() => ({
  settings: { experimentalWslHosts: false },
  saveSetting: async (updates: { experimentalWslHosts?: boolean }): Promise<void> => {
    if (updates.experimentalWslHosts !== undefined) {
      mocks.settings.experimentalWslHosts = updates.experimentalWslHosts
    }
  },
  updateSettingsOrThrow: vi.fn<(updates: { experimentalWslHosts?: boolean }) => Promise<void>>(),
  // Adds a test held open; released after each test so no run outlives it.
  held: new Set<(result: WslHostAddResult) => void>(),
  addWslHost:
    vi.fn<(args: { distro: string; startIfStopped: boolean }) => Promise<WslHostAddResult>>(),
  openMove: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: vi.fn(() => 'adding'), dismiss: vi.fn() }
}))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      settings: mocks.settings,
      updateSettingsOrThrow: mocks.updateSettingsOrThrow
    })
  }
}))
vi.mock('@/components/sidebar/host-admission/wsl/add-wsl-host-distro', () => ({
  addWslHostDistro: mocks.addWslHost
}))
vi.mock('@/components/wsl-move/wsl-move-entry', () => ({ openWslMoveDialogFor: mocks.openMove }))

import {
  isWslHostChatOfferSettingUp,
  wslHostChatOfferAction,
  type WslHostChatOffer
} from './structured-chat-wsl-host-offer'
import { acceptWslHostOffer } from '@/components/sidebar/wsl-host-offer-actions'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateSettingsOrThrow.mockImplementation(mocks.saveSetting)
  mocks.settings.experimentalWslHosts = false
  vi.stubGlobal('window', { api: { runtimeEnvironments: { wslHosts: {} } } })
})

afterEach(async () => {
  for (const finish of mocks.held) {
    finish({ ok: false, kind: 'failed', message: 'Released after the test.' })
  }
  mocks.held.clear()
  await vi.waitFor(() =>
    expect(['Ubuntu', 'Debian'].some((distro) => isWslHostChatOfferSettingUp(distro))).toBe(false)
  )
})

describe('wslHostChatOfferAction', () => {
  const offer: WslHostChatOffer = {
    distro: 'Ubuntu',
    projectKind: 'repo',
    projectId: 'repo-1',
    hostReady: false
  }

  function holdAdds(): Record<string, (result: WslHostAddResult) => void> {
    const finishes: Record<string, (result: WslHostAddResult) => void> = {}
    mocks.addWslHost.mockImplementation(
      ({ distro }) =>
        new Promise((resolve) => {
          finishes[distro] = resolve
          mocks.held.add(resolve)
        })
    )
    return finishes
  }

  function addProjectOfferDeps() {
    return {
      readWslHostsSetting: () => mocks.settings.experimentalWslHosts,
      updateSettings: mocks.updateSettingsOrThrow,
      addWslHost: mocks.addWslHost,
      addLocalPath: vi.fn(async () => undefined),
      moveAddedProject: vi.fn()
    }
  }

  const DEBIAN_OFFER = {
    path: '\\\\wsl.localhost\\Debian\\repo',
    distro: 'Debian',
    source: 'local_folder_picker'
  } as const

  it('restores the setting only once every run in flight failed', async () => {
    const finishes = holdAdds()
    const accepted = acceptWslHostOffer(DEBIAN_OFFER, addProjectOfferDeps())
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(mocks.addWslHost).toHaveBeenCalledTimes(2))
    finishes.Debian({ ok: false, kind: 'failed', message: 'Debian could not start.' })
    expect(await accepted).toMatchObject({ ok: false })
    // Ubuntu still runs, so the first failure leaves the setting on.
    expect(mocks.settings.experimentalWslHosts).toBe(true)
    finishes.Ubuntu({ ok: false, kind: 'failed', message: 'Ubuntu could not start.' })
    await vi.waitFor(() => expect(isWslHostChatOfferSettingUp('Ubuntu')).toBe(false))
    expect(mocks.settings.experimentalWslHosts).toBe(false)
    expect(mocks.openMove).not.toHaveBeenCalled()
  })

  it('keeps the setting on when any run in flight added its host', async () => {
    const finishes = holdAdds()
    const offerDeps = addProjectOfferDeps()
    const accepted = acceptWslHostOffer(DEBIAN_OFFER, offerDeps)
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(mocks.addWslHost).toHaveBeenCalledTimes(2))
    finishes.Ubuntu({ ok: true, environmentId: 'env-ubuntu' })
    finishes.Debian({ ok: false, kind: 'failed', message: 'Debian could not start.' })
    expect(await accepted).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalled())
    expect(mocks.settings.experimentalWslHosts).toBe(true)
    expect(offerDeps.addLocalPath).not.toHaveBeenCalled()
  })

  it('reads the setting for a new run only after the last one put it back', async () => {
    let finishRestore: () => void = () => undefined
    let restoreHeld = false
    mocks.addWslHost.mockResolvedValue({ ok: false, kind: 'failed', message: 'No.' })
    mocks.updateSettingsOrThrow.mockImplementation(async (updates) => {
      if (updates.experimentalWslHosts === false && !restoreHeld) {
        restoreHeld = true
        await new Promise<void>((resolve) => {
          finishRestore = resolve
        })
      }
      await mocks.saveSetting(updates)
    })
    const failed = acceptWslHostOffer(DEBIAN_OFFER, addProjectOfferDeps())
    await vi.waitFor(() =>
      expect(mocks.updateSettingsOrThrow).toHaveBeenCalledWith({ experimentalWslHosts: false })
    )
    const reads: boolean[] = []
    const next = acceptWslHostOffer(
      { ...DEBIAN_OFFER, distro: 'Ubuntu' },
      {
        ...addProjectOfferDeps(),
        readWslHostsSetting: () => {
          reads.push(mocks.settings.experimentalWslHosts)
          return mocks.settings.experimentalWslHosts
        }
      }
    )
    expect(reads).toEqual([])
    finishRestore()
    await failed
    await next
    expect(reads).toEqual([false])
  })
})
