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
vi.mock('@/runtime/hosts/ssh/runtime-environment-ssh-state', () => ({
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
      autoSelectTuiAgent: vi.fn(),
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
      preferredDefaultAgent: null,
      repoId: null,
      repoIdRef: { current: repoId },
      runtimeEnvironmentId: null,
      selectedRepoConnectionIdRef: { current: targetId },
      selectedRepoExecutionHostId: hostId,
      selectedRepoHookContextKey: null,
      selectedRepoIsGit: false,
      selectedRepoSshStatus: null,
      tuiAgent: 'claude'
    } as unknown as Parameters<typeof useHostRuntimeEffects>[0])
  )
}

describe('connecting the SSH target of the selected project', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { ssh: { connect: sshConnect } } })
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
