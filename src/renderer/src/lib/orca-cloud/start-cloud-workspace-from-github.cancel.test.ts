// @vitest-environment happy-dom
// GH-CREATE-CANCEL and GH-CREATE-NO-ROW for a GitHub-only Orca Cloud create: Cancel at any step
// leaves no workspace (the sandbox is deleted, which drops the pairing too), and a create that
// opens hands its pending row off to the paired server's rows, which stay hidden until then.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

type OpenOptions = { onHost?: (hostId: string) => void }
type OpenOutcome = { ok: true; worktreeId: string | null; hostId?: string }

const mocks = vi.hoisted(() => ({
  open: vi.fn<(workspace: unknown, options?: OpenOptions) => Promise<OpenOutcome>>(),
  launch: vi.fn()
}))

vi.mock('@/components/cloud-workspaces/open-cloud-workspace', () => ({
  openCloudWorkspace: mocks.open
}))
vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launch
}))

import { startCloudWorkspaceFromGitHub } from './start-cloud-workspace-from-github'
import { resetGitHubCreateKeysForTest } from './github-cloud-create-key'

const createFromGitHub = vi.fn<(args: unknown) => Promise<unknown>>()
const destroy = vi.fn(async () => ({ ok: true, value: undefined }))

beforeEach(() => {
  resetGitHubCreateKeysForTest()
  useAppStore.setState({ pendingWorktreeCreations: {}, activePendingCreationId: null })
  createFromGitHub.mockResolvedValue({ ok: true, value: { sandboxId: 'sbx_1' } })
  mocks.open.mockResolvedValue({ ok: true, worktreeId: null })
  Object.assign(window, {
    api: {
      ...window.api,
      orcaCloudWorkspace: { createFromGitHub },
      cloudWorkspaces: {
        get: vi.fn(async (id: string) => ({ ok: true, value: { id } })),
        destroy,
        localWorkspaces: vi.fn(async () => []),
        environmentBindings: vi.fn(async () => ({}))
      },
      ephemeralVm: {
        onProvisionEvent: () => () => {},
        cancelProvision: vi.fn(async () => ({ cancelled: true })),
        // Cancel's cleanup looks for this create's runtime records; a GitHub-only create has none.
        listRuntimes: vi.fn(async () => [])
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

const REQUEST = {
  repoUrl: 'https://github.com/acme/web',
  fullName: 'acme/web',
  prompt: '',
  agent: null,
  composerRepoId: 'repo-1'
}

const creationId = (): string =>
  Object.keys(useAppStore.getState().pendingWorktreeCreations)[0] ?? ''
const cancel = (): void => useAppStore.getState().removePendingWorktreeCreation(creationId())

describe('Cancel leaves no workspace (GH-CREATE-CANCEL)', () => {
  it('cancelled after the sandbox started, before it opened: deleted, never opened', async () => {
    createFromGitHub.mockImplementationOnce(async () => {
      cancel()
      return { ok: true, value: { sandboxId: 'sbx_1' } }
    })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(false)
    expect(mocks.open).not.toHaveBeenCalled()
    expect(destroy).toHaveBeenCalledWith('sbx_1')
  })

  it('cancelled while it opened: the sandbox is deleted (its pairing and row go with it)', async () => {
    mocks.open.mockImplementationOnce(async (_workspace, options) => {
      options?.onHost?.('runtime:p')
      cancel()
      return { ok: true, worktreeId: 'w1', hostId: 'runtime:p' }
    })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(false)
    expect(destroy).toHaveBeenCalledWith('sbx_1')
    expect(useAppStore.getState().pendingWorktreeCreations).toEqual({})
  })

  it('cancelled while the create was in flight: main reclaims it; nothing opens here', async () => {
    createFromGitHub.mockImplementationOnce(async () => {
      cancel()
      return { ok: false, code: 'failed', message: 'Cancelled.' }
    })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(false)
    expect(window.api.ephemeralVm.cancelProvision).toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})

describe('pending row hand-off (GH-CREATE-NO-ROW)', () => {
  it('records the paired server while opening, and the hand-off drops the pending row', async () => {
    let pairingHostIdDuringOpen: string | undefined
    mocks.open.mockImplementationOnce(async (_workspace, options) => {
      options?.onHost?.('runtime:p')
      pairingHostIdDuringOpen =
        useAppStore.getState().pendingWorktreeCreations[creationId()]?.pairingHostId
      return { ok: true, worktreeId: null }
    })
    expect(await startCloudWorkspaceFromGitHub(REQUEST)).toBe(true)
    expect(pairingHostIdDuringOpen).toBe('runtime:p')
    expect(useAppStore.getState().pendingWorktreeCreations).toEqual({})
    expect(destroy).not.toHaveBeenCalled()
  })
})
