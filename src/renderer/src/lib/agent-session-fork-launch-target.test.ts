import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

type TargetState = Pick<
  AppState,
  'repos' | 'settings' | 'getKnownWorktreeById' | 'runtimeStatusByEnvironmentId'
>

type TargetMocks = { runtimeEnvironmentId: string | null; executionHostId: string; state: unknown }

const mocks = vi.hoisted(() => {
  const initial: TargetMocks = { runtimeEnvironmentId: null, executionHostId: 'local', state: null }
  return initial
})

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'win32' }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.runtimeEnvironmentId,
  getExecutionHostIdForWorktree: () => mocks.executionHostId
}))

const { getForkAgentLaunchTarget } = await import('./agent-session-fork-launch-target')

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo',
    path: '/r',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function childWorktree(overrides: Partial<Worktree> = {}): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target reads only id, repoId, path and host fields.
  return {
    id: 'repo::child',
    repoId: 'repo',
    path: '/r/child',
    hostId: 'ssh:ssh-1',
    ...overrides
  } as Worktree
}

function makeState(worktree: Worktree, repos: Repo[]): TargetState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings only feed the Windows shell lookup.
  const settings = { terminalWindowsShell: 'powershell.exe' } as AppState['settings']
  return {
    repos,
    settings,
    getKnownWorktreeById: (id) => (id === worktree.id ? worktree : undefined),
    runtimeStatusByEnvironmentId: new Map()
  }
}

function target(state: TargetState): ReturnType<typeof getForkAgentLaunchTarget> {
  mocks.state = state
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target reads only the TargetState fields.
  return getForkAgentLaunchTarget(state as AppState, 'repo::child')
}

beforeEach(() => {
  mocks.runtimeEnvironmentId = null
  mocks.executionHostId = 'local'
})

describe('getForkAgentLaunchTarget', () => {
  it("quotes for the SSH host when a local repo shares the child's repo id", () => {
    mocks.executionHostId = 'ssh:ssh-1'
    const state = makeState(childWorktree(), [repo({}), repo({ connectionId: 'ssh-1' })])

    expect(target(state)).toMatchObject({ platform: 'linux', shell: undefined })
  })

  it('quotes for the local Windows shell when the child is the local repo', () => {
    const state = makeState(childWorktree({ hostId: 'local' }), [
      repo({ connectionId: 'ssh-1' }),
      repo({})
    ])

    expect(target(state)).toEqual({
      platform: 'win32',
      shell: 'powershell',
      runtimeEnvironmentId: null
    })
  })

  it("quotes for a runtime host's own platform, not the client's", () => {
    mocks.runtimeEnvironmentId = 'env-1'
    mocks.executionHostId = 'runtime:env-1'
    const state = makeState(
      childWorktree({ hostId: 'local', runtimeOwnerEnvironmentId: 'env-1' }),
      [repo({}), repo({ executionHostId: 'runtime:env-1' })]
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target reads only hostPlatform from a verified status.
    const status = { status: { hostPlatform: 'linux' } } as never
    state.runtimeStatusByEnvironmentId.set('env-1', status)

    expect(target(state)).toEqual({
      platform: 'linux',
      shell: undefined,
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('uses the remote PowerShell default for a Windows runtime host', () => {
    mocks.runtimeEnvironmentId = 'env-1'
    mocks.executionHostId = 'runtime:env-1'
    const state = makeState(
      childWorktree({ hostId: 'local', runtimeOwnerEnvironmentId: 'env-1' }),
      [repo({ executionHostId: 'runtime:env-1' })]
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the target reads only hostPlatform from a verified status.
    const status = { status: { hostPlatform: 'win32' } } as never
    state.runtimeStatusByEnvironmentId.set('env-1', status)

    expect(target(state)).toEqual({
      platform: 'win32',
      shell: 'powershell',
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('falls back to POSIX for a runtime host whose platform is not yet verified', () => {
    mocks.runtimeEnvironmentId = 'env-1'
    const state = makeState(
      childWorktree({ hostId: 'local', runtimeOwnerEnvironmentId: 'env-1' }),
      [repo({ executionHostId: 'runtime:env-1' })]
    )

    expect(target(state)).toEqual({
      platform: 'linux',
      shell: undefined,
      runtimeEnvironmentId: 'env-1'
    })
  })
})
