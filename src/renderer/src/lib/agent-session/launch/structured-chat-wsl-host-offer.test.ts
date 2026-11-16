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
  readWslHostChatOffer,
  wslHostChatOfferAction,
  type WslHostChatOffer,
  type WslHostChatOfferState
} from './structured-chat-wsl-host-offer'
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

  it('opens the move straight away when the host is ready', async () => {
    const action = wslHostChatOfferAction({ ...offer, hostReady: true })
    expect(action.label).toBe('Move to Ubuntu host…')
    action.onClick()
    await vi.waitFor(() => expect(mocks.openMove).toHaveBeenCalled())
    expect(mocks.addWslHost).not.toHaveBeenCalled()
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
})
