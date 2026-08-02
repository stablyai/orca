// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
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
