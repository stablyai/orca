// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostAddResult } from '../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

const mocks = vi.hoisted(() => ({
  settings: { experimentalWslHosts: false },
  updateSettingsOrThrow: vi.fn(async (updates: { experimentalWslHosts?: boolean }) => {
    if (updates.experimentalWslHosts !== undefined) {
      mocks.settings.experimentalWslHosts = updates.experimentalWslHosts
    }
  }),
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
  mocks.settings.experimentalWslHosts = false
  vi.stubGlobal('window', { api: { runtimeEnvironments: { wslHosts: {} } } })
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

  it('runs setups for different distros one after another', async () => {
    const order: string[] = []
    mocks.addWslHost.mockImplementation(async ({ distro }) => {
      order.push(`start ${distro}`)
      await Promise.resolve()
      order.push(`end ${distro}`)
      return { ok: true, environmentId: distro }
    })
    wslHostChatOfferAction(offer).onClick()
    wslHostChatOfferAction({ ...offer, distro: 'Debian' }).onClick()
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalledTimes(2))
    expect(order).toEqual(['start Ubuntu', 'end Ubuntu', 'start Debian', 'end Debian'])
  })

  it('shares one queue with the add-project offer, so restores never interleave', async () => {
    const finishes: Record<string, (result: WslHostAddResult) => void> = {}
    mocks.addWslHost.mockImplementation(
      ({ distro }) =>
        new Promise((resolve) => {
          finishes[distro] = resolve
        })
    )
    const offerDeps = {
      readWslHostsSetting: () => mocks.settings.experimentalWslHosts,
      updateSettings: mocks.updateSettingsOrThrow,
      addWslHost: mocks.addWslHost,
      addLocalPath: vi.fn(async () => undefined),
      moveAddedProject: vi.fn()
    }
    const accepted = acceptWslHostOffer(
      { path: '\\\\wsl.localhost\\Debian\\repo', distro: 'Debian', source: 'local_folder_picker' },
      offerDeps
    )
    wslHostChatOfferAction(offer).onClick()
    await vi.waitFor(() => expect(finishes.Debian).toBeDefined())
    // The chat's Ubuntu run waits; it hasn't read the setting the offer just turned on.
    expect(mocks.addWslHost).toHaveBeenCalledTimes(1)
    finishes.Debian({ ok: false, kind: 'failed', message: 'Debian could not start.' })
    expect(await accepted).toMatchObject({ ok: false })
    await vi.waitFor(() => expect(finishes.Ubuntu).toBeDefined())
    finishes.Ubuntu({ ok: true, environmentId: 'env-ubuntu' })
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalled())
    // The failed offer restored "off" before the chat's run read it; the chat's success stays on.
    expect(mocks.settings.experimentalWslHosts).toBe(true)
    expect(offerDeps.addLocalPath).not.toHaveBeenCalled()
  })

  it('lets the add-project offer join a chat setup of the same distro', async () => {
    let finishAdd: (result: WslHostAddResult) => void = () => undefined
    mocks.addWslHost.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishAdd = resolve
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
