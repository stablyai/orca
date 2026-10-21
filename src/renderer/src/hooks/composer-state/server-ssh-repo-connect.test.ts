// @vitest-environment happy-dom
// #25887: a workspace on a paired server's own SSH target must be connected by that server.
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, connectRuntimeEnvironmentSshTarget: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(mocks.state), {
    getState: () => mocks.state
  })
}))
vi.mock('@/runtime/runtime-environment-ssh-state', () => ({
  connectRuntimeEnvironmentSshTarget: mocks.connectRuntimeEnvironmentSshTarget,
  hydrateRuntimeEnvironmentSshState: vi.fn(async () => {})
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const { useHostRuntimeEffects } = await import('./host-runtime-effects')

const sshConnect = vi.fn()

function renderEffects(repoId: string, targetId: string, hostId: ExecutionHostId = 'local') {
  return renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the connect path reads only the refs and store set here; the rest are inert stubs.
    useHostRuntimeEffects({
      commitHookCheckIfCurrent: vi.fn(),
      connectionId: null,
      disabledTuiAgents: [],
      ensureDetectedAgents: vi.fn(async () => []),
      ensureRemoteDetectedAgents: vi.fn(async () => []),
      ensureRuntimeDetectedAgents: vi.fn(async () => []),
      fallbackDefaultAgent: null,
      folderTargetConnectionId: null,
      isRemote: false,
      loadHookCheckForRepo: vi.fn(),
      newWorkspaceDraft: null,
      repoId: null,
      repoIdRef: { current: repoId },
      runtimeEnvironmentId: null,
      selectedRepoConnectionIdRef: { current: targetId },
      selectedRepoExecutionHostId: hostId,
      selectedRepoHookContextKey: null,
      selectedRepoIsGit: false,
      selectedRepoSshStatus: null,
      setTuiAgent: vi.fn(),
      settings: null,
      tuiAgent: 'claude'
    } as unknown as Parameters<typeof useHostRuntimeEffects>[0])
  )
}

describe('connecting the SSH target of the selected project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { ssh: { connect: sshConnect } } })
  })

  it("asks the server to connect its own SSH target, never this client's", async () => {
    mocks.state = {
      repos: [
        {
          id: 'repo-dike',
          connectionId: 'ssh-dike',
          executionHostId: 'runtime:env-1'
        }
      ],
      sshConnectionStates: new Map()
    }
    const { result } = renderEffects('repo-dike', 'ssh-dike', 'runtime:env-1')

    await act(() => result.current.onConnectSelectedRepo())

    expect(mocks.connectRuntimeEnvironmentSshTarget).toHaveBeenCalledWith('env-1', 'ssh-dike')
    expect(sshConnect).not.toHaveBeenCalled()
  })

  it("connects this client's own SSH target locally, as before", async () => {
    mocks.state = {
      repos: [{ id: 'repo-local', connectionId: 'ssh-mine', executionHostId: 'ssh:ssh-mine' }],
      sshConnectionStates: new Map()
    }
    const { result } = renderEffects('repo-local', 'ssh-mine', 'ssh:ssh-mine')

    await act(() => result.current.onConnectSelectedRepo())

    expect(sshConnect).toHaveBeenCalledWith({ targetId: 'ssh-mine' })
    expect(mocks.connectRuntimeEnvironmentSshTarget).not.toHaveBeenCalled()
  })

  it('connects the selected SSH repo when a same-ID local repo appears first', async () => {
    mocks.state = {
      repos: [{ id: 'repeated' }, { id: 'repeated', connectionId: 'builder' }],
      sshConnectionStates: new Map()
    }
    const { result } = renderEffects('repeated', 'builder', 'ssh:builder')

    await act(() => result.current.onConnectSelectedRepo())

    expect(sshConnect).toHaveBeenCalledWith({ targetId: 'builder' })
    expect(mocks.connectRuntimeEnvironmentSshTarget).not.toHaveBeenCalled()
  })

  it.each(['ssh:builder', 'runtime:env-2'])(
    'does not connect the same target ID on sibling host %s',
    async (siblingHost) => {
      mocks.state = {
        repos: [
          { id: 'repeated', connectionId: 'builder', executionHostId: siblingHost },
          { id: 'repeated', connectionId: 'builder', executionHostId: 'runtime:env-1' }
        ],
        sshConnectionStates: new Map()
      }
      const { result } = renderEffects('repeated', 'builder', 'runtime:env-1')

      await act(() => result.current.onConnectSelectedRepo())

      expect(mocks.connectRuntimeEnvironmentSshTarget).toHaveBeenCalledWith('env-1', 'builder')
      expect(sshConnect).not.toHaveBeenCalled()
    }
  )
})

describe("agents for a project on a paired server's SSH host", () => {
  it("are detected by the server, never by probing this client's SSH connections", async () => {
    mocks.state = {
      remoteDetectedAgentIds: {},
      runtimeDetectedAgentIds: {},
      detectedAgentIds: null,
      ensureDetectedAgents: vi.fn(),
      ensureRemoteDetectedAgents: vi.fn(),
      ensureRuntimeDetectedAgents: vi.fn()
    }
    const { useWorkspaceIdentityState } = await import('./workspace-identity-state')

    const { result } = renderHook(() =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: identity state reads only these fields; the rest are inert.
      useWorkspaceIdentityState({
        persistDraft: false,
        newWorkspaceDraft: null,
        selectedRepoConnectionId: 'ssh-dike',
        selectedRepoRuntimeEnvironmentId: 'env-1',
        settings: null
      } as unknown as Parameters<typeof useWorkspaceIdentityState>[0])
    )

    expect(result.current.isRemote).toBe(false)
    // Attachment uploads still name the worktree's real host.
    expect(result.current.connectionId).toBe('ssh-dike')
    expect(result.current.runtimeEnvironmentId).toBe('env-1')
  })
})
