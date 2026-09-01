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
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
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
    settings: { activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: {
      'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: '/repo/worktree', hostId }]
    }
  }
}

function Probe({ enabled }: { enabled: boolean }): null {
  mocks.snapshots.push(useNativeChatSkills('codex', 'tab-1', enabled))
  return null
}

describe('useNativeChatSkills', () => {
  beforeEach(() => {
    mocks.state = stateForHost('local')
    mocks.snapshots = []
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue({
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
    })
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

  it('resolves the catalog for a structured session tab', async () => {
    mocks.state = {
      ...stateForHost('local'),
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        'worktree-1': [{ id: 'tab-1', contentType: 'agent-session', entityId: 'session-1' }]
      }
    }
    render(<Probe enabled />)

    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })

  it('surfaces discovery failure instead of remaining loading', async () => {
    mocks.callRuntimeRpc.mockRejectedValueOnce(new Error('scan failed'))
    render(<Probe enabled />)

    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('error'))
    expect(mocks.snapshots.at(-1)?.error?.message).toBe('scan failed')
  })

  it('surfaces missing tab ownership instead of remaining loading', () => {
    mocks.state = {
      ...stateForHost('local'),
      tabsByWorktree: {},
      unifiedTabsByWorktree: {}
    }
    render(<Probe enabled />)

    expect(mocks.snapshots.at(-1)?.status).toBe('error')
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

  it('marks SSH discovery unavailable without scanning another host', async () => {
    mocks.state = stateForHost('ssh:connection-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.errorKind).toBe('unavailable'))
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('makes Retry reach disk instead of the host shared scan', async () => {
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )

    act(() => {
      mocks.snapshots.at(-1)?.retry()
    })
    await waitFor(() => expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(2))

    // Why: Retry is the user saying "I changed something" — without `refresh` it
    // would be answered from the scan it is trying to get past.
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1', refresh: true },
      { timeoutMs: 10_000 }
    )
  })

  it('routes runtime-owned panes through their saved environment', async () => {
    mocks.state = stateForHost('runtime:env-1')
    render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'skills.discover',
      { cwd: '/repo/worktree', worktreeId: 'worktree-1' },
      { timeoutMs: 10_000 }
    )
  })
})
