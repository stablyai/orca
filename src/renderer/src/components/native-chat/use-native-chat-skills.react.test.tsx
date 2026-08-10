// @vitest-environment happy-dom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatSkillDiscovery } from './use-native-chat-skills'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  state: {} as Record<string, unknown>,
  snapshots: [] as NativeChatSkillDiscovery[]
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatSkillDiscovery: vi.fn() }))

import {
  resetNativeChatSkillDiscoveryCacheForTests,
  useNativeChatSkills
} from './use-native-chat-skills'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

function stateForHost(hostId: string) {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'worktree-1',
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        connectionId: null,
        executionHostId: hostId
      }
    ],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironments: [],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    worktreesByRepo: {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId }]
    }
  }
}

function sshConnectionState(targetId: string, connectionGeneration = 3) {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    connectionGeneration
  }
}

function connectedSshState(connectionGeneration = 3) {
  return {
    ...stateForHost('ssh:target-1'),
    sshConnectionStates: new Map([
      ['target-1', sshConnectionState('target-1', connectionGeneration)]
    ])
  }
}

function Probe({ enabled }: { enabled: boolean }): null {
  mocks.snapshots.push(useNativeChatSkills('codex', 'tab-1', enabled))
  return null
}

const DISCOVERY_RESULT = {
  skills: [
    {
      id: 'browser',
      name: 'browser',
      description: null,
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'Agent skills home',
      rootPath: '/home/test/.agents/skills',
      directoryPath: '/home/test/.agents/skills/browser',
      skillFilePath: '/home/test/.agents/skills/browser/SKILL.md',
      installed: true,
      fileCount: 1,
      updatedAt: null
    }
  ],
  sources: [
    {
      id: 'home-agents',
      label: 'Agent skills home',
      path: '/home/test/.agents/skills',
      sourceKind: 'home',
      providers: ['agent-skills'],
      owner: null,
      exists: true
    }
  ],
  scannedAt: 1
}

describe('useNativeChatSkills', () => {
  beforeEach(() => {
    mocks.state = stateForHost('local')
    mocks.snapshots = []
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue(DISCOVERY_RESULT)
    resetNativeChatSkillDiscoveryCacheForTests()
  })

  afterEach(() => cleanup())

  it('starts lazily and exposes loading separately from ready results', async () => {
    const view = render(<Probe enabled={false} />)
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(mocks.snapshots.at(-1)?.status).toBe('idle')

    view.rerender(<Probe enabled />)
    expect(mocks.snapshots.at(-1)?.status).toBe('loading')
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('does not inspect workspace catalogs while the picker is disabled', () => {
    mocks.state = new Proxy(connectedSshState(), {
      get() {
        throw new Error('disabled picker read store state')
      }
    })

    expect(() => render(<Probe enabled={false} />)).not.toThrow()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('shares one in-flight request between sibling panes', async () => {
    render(
      <>
        <Probe enabled />
        <Probe enabled />
      </>
    )
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('discovers SSH pane skills through the identity-only pane method', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', result: DISCOVERY_RESULT })
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discoverForPane',
      { worktreeId: 'worktree-1', terminalTabId: 'tab-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('maps an old relay to relay-upgrade-required with Retry intact', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'relay-upgrade-required' })
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('relay-upgrade-required'))
    expect(mocks.snapshots.at(-1)?.status).toBe('error')
    expect(typeof mocks.snapshots.at(-1)?.retry).toBe('function')
  })

  it('maps an old paired runtime (method_not_found) to runtime-upgrade-required', async () => {
    mocks.state = connectedSshState()
    mocks.callRuntimeRpc.mockRejectedValue(
      new RuntimeRpcCallError({
        error: { code: 'method_not_found', message: 'Unknown method: skills.discoverForPane' }
      } as never)
    )
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('runtime-upgrade-required'))
  })

  it('shows a host error for a disconnected SSH host without issuing the RPC', async () => {
    mocks.state = stateForHost('ssh:target-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('host'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('routes runtime-owned panes through their saved environment', async () => {
    mocks.state = stateForHost('runtime:env-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 18_000 }
    )
  })

  it('allows a cold runtime WSL scan to use its full sequential budget', async () => {
    vi.useFakeTimers()
    try {
      mocks.state = stateForHost('runtime:env-1')
      let resolveRequest!: (value: typeof DISCOVERY_RESULT) => void
      mocks.callRuntimeRpc.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          })
      )

      render(<Probe enabled />)
      expect(mocks.snapshots.at(-1)?.status).toBe('loading')
      await act(async () => vi.advanceTimersByTimeAsync(32_000))
      expect(mocks.snapshots.at(-1)?.status).toBe('loading')
      await act(async () => resolveRequest(DISCOVERY_RESULT))
      expect(mocks.snapshots.at(-1)?.status).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes an ordinary paired SSH pane through its owning runtime', async () => {
    mocks.state = {
      ...stateForHost('ssh:private-target'),
      sshConnectionStates: new Map([['private-target', sshConnectionState('private-target')]]),
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          {
            connectionStates: new Map([['private-target', sshConnectionState('private-target')]])
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'worktree-1',
            repoId: 'repo-1',
            path: '/repo/worktree',
            hostId: 'ssh:private-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    }
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', result: DISCOVERY_RESULT })

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub-a' },
      'skills.discoverForPane',
      { worktreeId: 'worktree-1', terminalTabId: 'tab-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('routes a projected paired SSH folder through pane discovery', async () => {
    const worktreeId = 'folder:folder-1'
    mocks.state = {
      ...stateForHost('runtime:hub-a'),
      activeWorktreeId: worktreeId,
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/remote/folder',
          executionHostId: 'runtime:hub-a'
        }
      ],
      projectGroups: [
        {
          id: 'group-1',
          connectionId: 'private-target',
          executionHostId: 'runtime:hub-a'
        }
      ],
      sshStateByEnvironment: new Map([
        [
          'hub-a',
          { connectionStates: new Map([['private-target', sshConnectionState('private-target')]]) }
        ]
      ]),
      tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
      worktreesByRepo: {}
    }
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', result: DISCOVERY_RESULT })

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'hub-a' },
      'skills.discoverForPane',
      { worktreeId, terminalTabId: 'tab-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('issues no RPC while a restored runtime folder catalog is missing', async () => {
    const worktreeId = 'folder:folder-1'
    mocks.state = {
      ...stateForHost('runtime:hub-a'),
      activeWorktreeId: worktreeId,
      folderWorkspaces: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: 'runtime:hub-a' },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', startupCwd: '/possibly-remote/folder' }]
      },
      worktreesByRepo: {}
    }

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('idle'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('issues no RPC before a local folder project group hydrates', async () => {
    const worktreeId = 'folder:folder-1'
    mocks.state = {
      ...stateForHost('local'),
      activeWorktreeId: worktreeId,
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/possibly-remote/folder',
          executionHostId: 'local'
        }
      ],
      projectGroups: [],
      repos: [],
      tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
      worktreesByRepo: {}
    }

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('idle'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('issues no RPC for duplicate local folder identities', async () => {
    const worktreeId = 'folder:folder-1'
    mocks.state = {
      ...stateForHost('local'),
      activeWorktreeId: worktreeId,
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/first/folder',
          executionHostId: 'local'
        },
        {
          id: 'folder-1',
          projectGroupId: 'group-2',
          folderPath: '/second/folder',
          executionHostId: 'local'
        }
      ],
      projectGroups: [
        { id: 'group-1', executionHostId: 'local' },
        { id: 'group-2', executionHostId: 'local' }
      ],
      repos: [],
      tabsByWorktree: { [worktreeId]: [{ id: 'tab-1' }] },
      worktreesByRepo: {}
    }

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('idle'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps a legacy local pane local when several runtimes are saved', async () => {
    mocks.state = {
      ...stateForHost('local'),
      activeWorktreeId: 'other-worktree',
      repos: [{ id: 'repo-1', path: '/repo', connectionId: null, executionHostId: null }],
      runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      worktreesByRepo: {
        'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree' }]
      }
    }

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('issues no RPC for an ambiguous direct and paired SSH pane', async () => {
    mocks.state = {
      ...stateForHost('ssh:shared-target'),
      activeWorkspaceExecutionHostId: 'ssh:shared-target',
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          connectionId: 'shared-target',
          executionHostId: 'runtime:hub-a'
        }
      ],
      sshConnectionStates: new Map([['shared-target', sshConnectionState('shared-target')]]),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'worktree-1',
            repoId: 'repo-1',
            path: '/repo/worktree',
            hostId: 'ssh:shared-target'
          },
          {
            id: 'worktree-1',
            repoId: 'repo-1',
            path: '/repo/worktree',
            hostId: 'ssh:shared-target',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    }

    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('idle'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('bounds cached SSH reconnect generations per composer', async () => {
    mocks.state = connectedSshState(1)
    mocks.callRuntimeRpc.mockResolvedValue({ status: 'ok', result: DISCOVERY_RESULT })
    const view = render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))

    for (let generation = 2; generation <= 9; generation += 1) {
      mocks.state = connectedSshState(generation)
      view.rerender(<Probe enabled />)
      await waitFor(() => {
        expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(generation)
        expect(mocks.snapshots.at(-1)?.status).toBe('ready')
      })
    }

    mocks.state = connectedSshState(1)
    view.rerender(<Probe enabled />)
    await waitFor(() => {
      expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(10)
      expect(mocks.snapshots.at(-1)?.status).toBe('ready')
    })
  })

  it('does not cache a canceled reconnect generation', async () => {
    const pending: ((value: { status: 'ok'; result: typeof DISCOVERY_RESULT }) => void)[] = []
    mocks.state = connectedSshState(1)
    mocks.callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve)
        })
    )
    const view = render(<Probe enabled />)
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1))

    mocks.state = connectedSshState(2)
    view.rerender(<Probe enabled />)
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2))
    await act(async () => pending[1]({ status: 'ok', result: DISCOVERY_RESULT }))
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    await act(async () => pending[0]({ status: 'ok', result: DISCOVERY_RESULT }))

    mocks.state = connectedSshState(1)
    view.rerender(<Probe enabled />)
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(3))
  })
})
