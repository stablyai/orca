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
  toastError: vi.fn(),
  store: {
    wslHostsAcceptNewWork: true,
    wslHostServerFiles: 'present',
    repos: [{ id: 'repo-1', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }],
    folderWorkspaces: [],
    runtimeEnvironments: []
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, loading: vi.fn(() => 'adding'), dismiss: vi.fn() }
}))
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      ...mocks.store,
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
  readWslHostChatOffer,
  readWslHostChatOfferForLaunch,
  isWslHostChatOfferSettingUp,
  wslHostChatOfferAction,
  type WslHostChatOffer,
  type WslHostChatOfferState
} from './structured-chat-wsl-host-offer'
import { acceptWslHostOffer } from '@/components/sidebar/wsl-host-offer-actions'
import { structuredChatUnavailableToast } from './structured-agent-session-launch-failure'
import { structuredSessionNotices } from '@/components/native-chat/messages/notices/native-chat-structured-session-notices'

const REPO_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const WORKTREE_ID = `repo-1::${REPO_PATH}`

function state(overrides: Partial<WslHostChatOfferState> = {}): WslHostChatOfferState {
  return {
    settings: null,
    wslHostsAcceptNewWork: true,
    wslHostServerFiles: 'present',
    repos: [{ id: 'repo-1', path: REPO_PATH }],
    folderWorkspaces: [],
    runtimeEnvironments: [],
    ...overrides
  }
}

const wslHost = {
  name: 'Ubuntu (WSL)',
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 7000, remotePort: 7001 }
} as const

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

describe('readWslHostChatOffer', () => {
  it('offers to run the distro as a host while the setting is still off', () => {
    expect(readWslHostChatOffer(state(), WORKTREE_ID)).toEqual({
      distro: 'Ubuntu',
      projectKind: 'repo',
      projectId: 'repo-1',
      hostReady: false
    })
  })

  it('offers only the move once the distro is a host and the setting is on', () => {
    const offer = readWslHostChatOffer(
      state({ settings: { experimentalWslHosts: true }, runtimeEnvironments: [wslHost] }),
      WORKTREE_ID
    )
    expect(offer?.hostReady).toBe(true)
  })

  it('offers a folder workspace in the distro', () => {
    const offer = readWslHostChatOffer(
      state({ repos: [], folderWorkspaces: [{ id: 'f1', folderPath: REPO_PATH }] }),
      'folder:f1'
    )
    expect(offer).toMatchObject({ projectKind: 'folder', projectId: 'f1' })
  })

  it('offers nothing while this desktop cannot add WSL hosts', () => {
    expect(readWslHostChatOffer(state({ wslHostsAcceptNewWork: false }), WORKTREE_ID)).toBeNull()
    expect(readWslHostChatOffer(state({ wslHostServerFiles: 'missing' }), WORKTREE_ID)).toBeNull()
    vi.stubGlobal('window', { api: { runtimeEnvironments: {} } })
    expect(readWslHostChatOffer(state(), WORKTREE_ID)).toBeNull()
  })

  it('offers nothing for a Windows drive reached through the distro or an SSH project', () => {
    const mount = '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo'
    expect(
      readWslHostChatOffer(state({ repos: [{ id: 'repo-1', path: mount }] }), `repo-1::${mount}`)
    ).toBeNull()
    expect(
      readWslHostChatOffer(
        state({ repos: [{ id: 'repo-1', path: REPO_PATH, connectionId: 'ssh-1' }] }),
        WORKTREE_ID
      )
    ).toBeNull()
  })
})

describe('wslHostChatOfferAction', () => {
  const offer: WslHostChatOffer = {
    distro: 'Ubuntu',
    projectKind: 'repo',
    projectId: 'repo-1',
    hostReady: false
  }

  it('turns the setting on, adds the distro, then opens the move for this project', async () => {
    mocks.addWslHost.mockResolvedValue({ ok: true, environmentId: 'env-ubuntu' })
    const action = wslHostChatOfferAction(offer)
    expect(action.label).toBe('Run Ubuntu as a host')
    action.onClick()
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalled())
    expect(mocks.updateSettingsOrThrow).toHaveBeenCalledWith({ experimentalWslHosts: true })
    expect(mocks.addWslHost).toHaveBeenCalledWith({ distro: 'Ubuntu', startIfStopped: true })
    expect(mocks.openMove).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-1' })
  })

  it('restores the setting and says why when the add fails', async () => {
    mocks.addWslHost.mockResolvedValue({
      ok: false,
      kind: 'unsupported-wsl1',
      message: 'Ubuntu runs WSL 1.'
    })
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
    expect(mocks.settings.experimentalWslHosts).toBe(false)
    expect(mocks.openMove).not.toHaveBeenCalled()
  })

  it('runs one setup for repeated and concurrent clicks across surfaces', async () => {
    let finishAdd: (result: WslHostAddResult) => void = () => undefined
    mocks.addWslHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdd = resolve
          mocks.held.add(resolve)
        })
    )
    const first = wslHostChatOfferAction(offer)
    first.onClick()
    first.onClick()
    // Another surface (the toast) for the same distro, spelled differently, joins too.
    wslHostChatOfferAction({ ...offer, distro: 'ubuntu' }).onClick()
    await vi.waitFor(() => expect(mocks.addWslHost).toHaveBeenCalledTimes(1))
    expect(isWslHostChatOfferSettingUp('UBUNTU')).toBe(true)
    const busy = wslHostChatOfferAction(offer, undefined, true)
    expect(busy).toMatchObject({ label: 'Setting up…', disabled: true })
    finishAdd({ ok: false, kind: 'failed', message: 'Could not start the server.' })
    await vi.waitFor(() => expect(isWslHostChatOfferSettingUp('Ubuntu')).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    // The one failed setup restores what it read: the setting stays off.
    expect(mocks.settings.experimentalWslHosts).toBe(false)
    expect(mocks.openMove).not.toHaveBeenCalled()
  })

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

  it('runs setups for different distros side by side', async () => {
    const finishes = holdAdds()
    wslHostChatOfferAction(offer).onClick()
    wslHostChatOfferAction({ ...offer, distro: 'Debian' }).onClick()
    await vi.waitFor(() => expect(mocks.addWslHost).toHaveBeenCalledTimes(2))
    expect(Object.keys(finishes).sort()).toEqual(['Debian', 'Ubuntu'])
  })

  it('does not hold one distro behind another that hangs', async () => {
    const finishes = holdAdds()
    // The add-project offer's Debian add hangs; the chat's Ubuntu setup still finishes.
    void acceptWslHostOffer(DEBIAN_OFFER, addProjectOfferDeps())
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(finishes.Ubuntu).toBeDefined())
    finishes.Ubuntu({ ok: true, environmentId: 'env-ubuntu' })
    await vi.waitFor(() =>
      expect(mocks.openMove).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-1' })
    )
    expect(isWslHostChatOfferSettingUp('Debian')).toBe(true)
    expect(mocks.settings.experimentalWslHosts).toBe(true)
  })

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

  it('lets the add-project offer join a chat setup of the same distro', async () => {
    let finishAdd: (result: WslHostAddResult) => void = () => undefined
    mocks.addWslHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdd = resolve
          mocks.held.add(resolve)
        })
    )
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(mocks.addWslHost).toHaveBeenCalledTimes(1))
    const offerDeps = {
      readWslHostsSetting: () => mocks.settings.experimentalWslHosts,
      updateSettings: mocks.updateSettingsOrThrow,
      addWslHost: mocks.addWslHost,
      addLocalPath: vi.fn(async () => undefined),
      moveAddedProject: vi.fn()
    }
    const accepted = acceptWslHostOffer(
      { path: '\\\\wsl.localhost\\ubuntu\\repo', distro: 'ubuntu', source: 'local_folder_picker' },
      offerDeps
    )
    finishAdd({ ok: true, environmentId: 'env-ubuntu' })
    expect(await accepted).toBeNull()
    expect(mocks.addWslHost).toHaveBeenCalledTimes(1)
    expect(offerDeps.addLocalPath).toHaveBeenCalledTimes(1)
    expect(offerDeps.moveAddedProject).toHaveBeenCalledTimes(1)
  })

  it('opens the move straight away when the host is ready', async () => {
    const action = wslHostChatOfferAction({ ...offer, hostReady: true })
    expect(action.label).toBe('Move to Ubuntu host…')
    action.onClick()
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalled())
    expect(mocks.addWslHost).not.toHaveBeenCalled()
  })
})

describe('readWslHostChatOfferForLaunch', () => {
  const wslFailure = {
    kind: 'refused',
    code: 'structured_agent_session_unsupported',
    hostReason: 'wsl'
  } as const

  it('offers only for a failed start the host refused as WSL', () => {
    expect(
      readWslHostChatOfferForLaunch(
        state(),
        { lifecycle: 'failed', failure: wslFailure },
        WORKTREE_ID
      )
    ).toMatchObject({ distro: 'Ubuntu' })
    expect(
      readWslHostChatOfferForLaunch(
        state(),
        { lifecycle: 'failed', failure: { ...wslFailure, hostReason: 'remote' } },
        WORKTREE_ID
      )
    ).toBeNull()
    expect(
      readWslHostChatOfferForLaunch(
        state(),
        { lifecycle: 'visibility-unknown', failure: wslFailure },
        WORKTREE_ID
      )
    ).toBeNull()
    expect(
      readWslHostChatOfferForLaunch(state(), { lifecycle: 'failed', failure: null }, WORKTREE_ID)
    ).toBeNull()
  })
})

describe('structuredChatUnavailableToast', () => {
  it('keeps the plain words for other refusals', () => {
    expect(structuredChatUnavailableToast('remote', WORKTREE_ID)).toEqual({
      description: 'Chat is not available over SSH. Open the agent in a terminal instead.'
    })
  })

  it('keeps the plain words when the workspace has no offer', () => {
    vi.stubGlobal('window', { api: { runtimeEnvironments: {} } })
    expect(structuredChatUnavailableToast('wsl', WORKTREE_ID)).toEqual({
      description: 'Chat is not available in WSL. Open the agent in a terminal instead.'
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { wslHosts: {} } } })
    expect(structuredChatUnavailableToast('wsl', 'repo-unknown::/elsewhere')).not.toHaveProperty(
      'action'
    )
  })

  it('wires the toast button to the host setup for this project', async () => {
    mocks.addWslHost.mockResolvedValue({ ok: true, environmentId: 'env-ubuntu' })
    const toastOptions = structuredChatUnavailableToast('wsl', WORKTREE_ID)
    expect(toastOptions.description).toContain('Run the project on a WSL host')
    expect(toastOptions.action?.label).toBe('Run Ubuntu as a host')
    toastOptions.action?.onClick()
    await vi.waitFor(() =>
      expect(mocks.openMove).toHaveBeenCalledWith('Ubuntu', { kind: 'repo', id: 'repo-1' })
    )
  })
})

describe('the chat composer notice', () => {
  it('replaces Retry with the WSL host path for a WSL folder', () => {
    const [notice] = structuredSessionNotices({
      launch: {
        lifecycle: 'failed',
        failure: {
          kind: 'refused',
          code: 'structured_agent_session_unsupported',
          hostReason: 'wsl'
        },
        retry: vi.fn()
      },
      agentLabel: 'Claude',
      sessionError: null,
      composerError: null,
      wslHostOffer: {
        distro: 'Ubuntu',
        projectKind: 'repo',
        projectId: 'repo-1',
        hostReady: false
      }
    })
    expect(notice?.text).toContain('Run the project on a WSL host to chat there')
    expect(notice?.action?.label).toBe('Run Ubuntu as a host')
  })

  it('shows the button busy while the host is being set up', () => {
    const [notice] = structuredSessionNotices({
      launch: { lifecycle: 'failed', failure: null, retry: vi.fn() },
      agentLabel: 'Claude',
      sessionError: null,
      composerError: null,
      wslHostOffer: {
        distro: 'Ubuntu',
        projectKind: 'repo',
        projectId: 'repo-1',
        hostReady: false
      },
      wslHostOfferSettingUp: true
    })
    expect(notice?.action).toMatchObject({ label: 'Setting up…', disabled: true })
  })
})
