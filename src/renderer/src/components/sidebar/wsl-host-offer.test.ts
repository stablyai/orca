import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readWslHostOfferGate,
  shouldOfferWslHost,
  wslHostOfferDistro,
  wslHostOfferFor,
  type WslHostOfferGate
} from './wsl-host-offer'
import type { WslHostAddResult } from '../../../../shared/wsl-host-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  acceptWslHostOffer,
  declineWslHostOffer,
  type WslHostOffer
} from './wsl-host-offer-actions'

const open: WslHostOfferGate = { gateOpen: true, settingOn: false, dismissed: false }

describe('wslHostOfferDistro', () => {
  it.each([
    ['\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', 'Ubuntu'],
    ['\\\\wsl$\\Debian\\home\\me\\repo', 'Debian'],
    ['\\\\WSL.LOCALHOST\\Ubuntu-22.04\\srv', 'Ubuntu-22.04'],
    ['\\\\WSL$\\Arch', 'Arch'],
    ['//wsl.localhost/Ubuntu/home/me', 'Ubuntu']
  ])('reads the distro from %s', (path, distro) => {
    expect(wslHostOfferDistro(path)).toBe(distro)
  })

  it.each([
    'C:\\Users\\me\\repo',
    '\\\\server\\share\\repo',
    '\\\\wsl.localhostx\\Ubuntu\\repo',
    '/home/me/repo',
    '/mnt/c/Users/me',
    ''
  ])('offers nothing for %s', (path) => {
    expect(wslHostOfferDistro(path)).toBeNull()
  })
})

describe('shouldOfferWslHost', () => {
  const cases: [WslHostOfferGate, boolean][] = []
  for (const gateOpen of [true, false]) {
    for (const settingOn of [true, false]) {
      for (const dismissed of [true, false]) {
        cases.push([{ gateOpen, settingOn, dismissed }, gateOpen && !settingOn && !dismissed])
      }
    }
  }

  it.each(cases)('%o offers: %s', (gate, expected) => {
    expect(shouldOfferWslHost(gate)).toBe(expected)
  })

  it('offers only for a WSL path once visible', () => {
    expect(wslHostOfferFor('\\\\wsl$\\Ubuntu\\repo', open)).toBe('Ubuntu')
    expect(wslHostOfferFor('C:\\repo', open)).toBeNull()
    expect(wslHostOfferFor('\\\\wsl$\\Ubuntu\\repo', { ...open, dismissed: true })).toBeNull()
  })
})

describe('readWslHostOfferGate', () => {
  afterEach(() => vi.unstubAllGlobals())
  const state = {
    settings: null,
    wslHostsAcceptNewWork: true,
    wslHostServerFiles: 'present' as const
  }

  it('is closed where the preload offers no WSL hosts (not Windows, or gate closed)', () => {
    vi.stubGlobal('window', { api: { runtimeEnvironments: {} } })
    expect(readWslHostOfferGate(state).gateOpen).toBe(false)
  })

  it('is open with WSL hosts available, accepting new work and shipped server files', () => {
    vi.stubGlobal('window', { api: { runtimeEnvironments: { wslHosts: {} } } })
    expect(readWslHostOfferGate(state)).toEqual({
      gateOpen: true,
      settingOn: false,
      dismissed: false
    })
    expect(readWslHostOfferGate({ ...state, wslHostsAcceptNewWork: false }).gateOpen).toBe(false)
    expect(readWslHostOfferGate({ ...state, wslHostServerFiles: 'missing' }).gateOpen).toBe(false)
  })

  it('reads the setting and the dismissal from settings', () => {
    vi.stubGlobal('window', { api: { runtimeEnvironments: { wslHosts: {} } } })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only these two settings.
    const settings = { experimentalWslHosts: true, wslHostOfferDismissed: true } as GlobalSettings
    expect(readWslHostOfferGate({ ...state, settings })).toMatchObject({
      settingOn: true,
      dismissed: true
    })
  })
})

describe('offer actions', () => {
  const offer: WslHostOffer = {
    path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
    distro: 'Ubuntu',
    source: 'local_folder_picker'
  }

  function deps(addResult: WslHostAddResult) {
    const calls: string[] = []
    const acceptDeps = {
      readWslHostsSetting: () => false,
      updateSettings: vi.fn(async (updates: Partial<GlobalSettings>) => {
        calls.push(`settings ${JSON.stringify(updates)}`)
      }),
      addWslHost: vi.fn(async (args: { distro: string; startIfStopped: boolean }) => {
        calls.push(`host ${args.distro}`)
        return addResult
      }),
      addLocalPath: vi.fn(async (path: string) => {
        calls.push(`project ${path}`)
      })
    }
    return { calls, acceptDeps }
  }

  it('accept turns hosts on, adds the distro, then adds the project', async () => {
    const { calls, acceptDeps: d } = deps({ ok: true, environmentId: 'wsl:ubuntu' })
    expect(await acceptWslHostOffer(offer, d)).toBeNull()
    expect(calls).toEqual([
      'settings {"experimentalWslHosts":true}',
      'host Ubuntu',
      `project ${offer.path}`
    ])
  })

  it('accept goes on when the distro is already a host', async () => {
    const { acceptDeps: d } = deps({ ok: false, kind: 'already-added', message: 'x' })
    expect(await acceptWslHostOffer(offer, d)).toBeNull()
    expect(d.addLocalPath).toHaveBeenCalledOnce()
  })

  it('accept stops, restores the setting and returns a refusal without adding the project', async () => {
    const refusal = { ok: false as const, kind: 'unsupported-wsl1' as const, message: 'wsl1' }
    const { calls, acceptDeps: d } = deps(refusal)
    expect(await acceptWslHostOffer(offer, d)).toEqual(refusal)
    expect(d.addLocalPath).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'settings {"experimentalWslHosts":true}',
      'host Ubuntu',
      'settings {"experimentalWslHosts":false}'
    ])
  })

  it('accept restores the setting when the host add throws', async () => {
    const { calls, acceptDeps: d } = deps({ ok: true, environmentId: 'unused' })
    d.addWslHost.mockRejectedValueOnce(new Error('ipc gone'))
    await expect(acceptWslHostOffer(offer, d)).rejects.toThrow('ipc gone')
    expect(d.addLocalPath).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'settings {"experimentalWslHosts":true}',
      'settings {"experimentalWslHosts":false}'
    ])
  })

  it('a decline after a failed accept leaves the setting as it was', async () => {
    const refusal = { ok: false as const, kind: 'failed' as const, message: 'no' }
    const { acceptDeps: d } = deps(refusal)
    await acceptWslHostOffer(offer, d)
    await declineWslHostOffer(offer, d)
    expect(d.updateSettings).toHaveBeenLastCalledWith({ wslHostOfferDismissed: true })
    expect(d.updateSettings.mock.calls.map(([u]) => u)).toEqual([
      { experimentalWslHosts: true },
      { experimentalWslHosts: false },
      { wslHostOfferDismissed: true }
    ])
  })

  it('restores a setting that was already on', async () => {
    const { acceptDeps: d } = deps({ ok: false, kind: 'failed', message: 'no' })
    d.readWslHostsSetting = () => true
    await acceptWslHostOffer(offer, d)
    expect(d.updateSettings).toHaveBeenLastCalledWith({ experimentalWslHosts: true })
  })

  it('decline remembers the choice and adds the project as before', async () => {
    const { calls, acceptDeps: d } = deps({ ok: true, environmentId: 'unused' })
    await declineWslHostOffer(offer, d)
    expect(calls).toEqual(['settings {"wslHostOfferDismissed":true}', `project ${offer.path}`])
    expect(d.addWslHost).not.toHaveBeenCalled()
  })
})
