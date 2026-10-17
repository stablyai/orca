import { beforeEach, describe, expect, it, vi } from 'vitest'
import { worktree } from './worktree-list-groups-test-fixtures'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import type * as Owner from '@/runtime/structured-agent-session-owner'

type SleepTestState = {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  folderWorkspaces: {
    id: string
    projectGroupId: string
    connectionId: string | null
    executionHostId: string | null
  }[]
  projectGroups: { id: string; connectionId: string | null; executionHostId: string | null }[]
  worktreesByRepo?: Record<string, { id: string; repoId: string; hostId: string }[]>
  setActiveWorktree: ReturnType<typeof vi.fn>
  shutdownWorktreeBrowsers: ReturnType<typeof vi.fn>
  shutdownWorktreeTerminals: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => {
  const state: SleepTestState = {
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    folderWorkspaces: [],
    projectGroups: [],
    setActiveWorktree: vi.fn((id: string | null) => {
      state.activeWorktreeId = id
      if (id === null) {
        state.activeWorkspaceExecutionHostId = null
      }
    }),
    shutdownWorktreeBrowsers: vi.fn().mockResolvedValue(undefined),
    shutdownWorktreeTerminals: vi.fn().mockResolvedValue(undefined)
  }
  return {
    state,
    call: vi.fn().mockResolvedValue({ stoppedSessionIds: ['session-1'] }),
    target: vi.fn<(host: string) => unknown>(() => ({ kind: 'local' })),
    suspend: vi.fn().mockResolvedValue(null),
    toast: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/runtime/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForHost: mocks.target
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  runSleepWorktree,
  runSleepWorktrees,
  sleepWorktreesReportingFailures
} from './sleep-worktree-flow'
import {
  clearWorktreeSleepIntent,
  forgetWorktreeSleepIntent,
  hasWorktreeSleepTeardown,
  hasWorktreeSleepIntent
} from '@/lib/worktree-sleep-intent'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('workspace sleep flow', () => {
  it('keeps paired SSH execution identity through selection, intent and teardown', async () => {
    const owner = await vi.importActual<typeof Owner>('@/runtime/structured-agent-session-owner')
    mocks.target.mockImplementationOnce(owner.structuredAgentSessionTargetForHost)
    const target = withRepoHostOwnership(
      { ...worktree, hostId: 'ssh:target' as const },
      'runtime:hub'
    )
    mocks.state.activeWorktreeId = target.id
    mocks.state.activeWorkspaceExecutionHostId = 'ssh:target'
    mocks.state.shutdownWorktreeTerminals.mockImplementationOnce(async () => {
      expect(mocks.state.activeWorktreeId).toBeNull()
      expect(hasWorktreeSleepTeardown(target.id, 'ssh:target')).toBe(true)
    })
    const result = await runSleepWorktrees([target])
    expect(result[0]).toMatchObject({
      executionHostId: 'ssh:target',
      completed: true
    })
    expect(hasWorktreeSleepIntent(target.id, 'ssh:target')).toBe(true)
    expect(hasWorktreeSleepIntent(target.id, 'runtime:hub')).toBe(false)
    expect(mocks.call).not.toHaveBeenCalled()
  })

  beforeEach(() => {
    vi.stubGlobal('window', {
      api: { ephemeralVm: { suspendWorkspace: mocks.suspend } }
    })
    for (const id of ['wt-1', 'wt-2', 'folder:folder-1']) {
      forgetWorktreeSleepIntent(id)
    }
    mocks.state.activeWorktreeId = null
    mocks.state.activeWorkspaceExecutionHostId = null
    mocks.state.folderWorkspaces = []
    mocks.state.projectGroups = []
    mocks.state.worktreesByRepo = undefined
    mocks.state.setActiveWorktree.mockClear()
    mocks.state.shutdownWorktreeBrowsers.mockClear().mockResolvedValue(undefined)
    mocks.state.shutdownWorktreeTerminals.mockClear().mockResolvedValue(undefined)
    mocks.call.mockClear().mockResolvedValue({ stoppedSessionIds: ['session-1'] })
    mocks.target.mockClear()
    mocks.suspend.mockClear().mockResolvedValue(null)
    mocks.toast.mockClear()
  })

  it('issues native stop before panels and keeps the chat tab identity outside teardown', async () => {
    const native = deferred<{ stoppedSessionIds: string[] }>()
    mocks.call.mockReturnValueOnce(native.promise)
    const sleep = runSleepWorktree('wt-1', 'local')
    expect(mocks.call).toHaveBeenCalledWith({ kind: 'local' }, 'agentSession.sleepWorkspace', {
      workspaceId: 'wt-1'
    })
    expect(mocks.state.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    native.resolve({ stoppedSessionIds: ['session-1'] })
    await expect(sleep).resolves.toEqual([
      {
        workspaceId: 'wt-1',
        executionHostId: 'local',
        stoppedSessionIds: ['session-1'],
        completed: true
      }
    ])
    expect(mocks.state.shutdownWorktreeBrowsers).toHaveBeenCalledBefore(
      mocks.state.shutdownWorktreeTerminals
    )
    expect(mocks.suspend).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      executionHostId: 'local'
    })
  })

  it('keeps successfully stopped terminals asleep on a native RPC failure', async () => {
    mocks.call.mockRejectedValueOnce(new Error('method_not_found'))
    const result = await runSleepWorktree('wt-1', 'local')
    expect(result[0]).toMatchObject({ completed: false, stoppedSessionIds: [] })
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalled()
    expect(mocks.suspend).toHaveBeenCalled()
    expect(hasWorktreeSleepIntent('wt-1', 'local')).toBe(true)
    expect(mocks.toast).toHaveBeenCalledTimes(1)
  })

  it('keeps proved chat stops but leaves the workspace incomplete when another stop is unverified', async () => {
    mocks.call.mockResolvedValueOnce({
      stoppedSessionIds: ['session-1'],
      failures: [{ sessionId: 'session-2', reason: 'stop-unverifiable' }]
    })

    const result = await runSleepWorktree('wt-1', 'local')
    expect(result[0]).toMatchObject({ completed: false, stoppedSessionIds: ['session-1'] })
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalled()
    expect(mocks.toast).toHaveBeenCalledTimes(1)
  })

  it('reports an unverified chat stop to a caller that answers for it, without a toast', async () => {
    mocks.call
      .mockResolvedValueOnce({
        stoppedSessionIds: [],
        failures: [{ sessionId: 'session-1', reason: 'stop-unverifiable' }]
      })
      .mockResolvedValueOnce({ stoppedSessionIds: ['session-2'] })

    const outcome = await sleepWorktreesReportingFailures([
      { id: 'wt-1', executionHostId: 'local' },
      { id: 'wt-2', executionHostId: 'local' }
    ])

    expect(outcome.failedWorktreeIds).toEqual(['wt-1'])
    expect(outcome.errors).toHaveLength(1)
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('keeps a superseded chat quiet while completing other workspace cleanup', async () => {
    mocks.call.mockResolvedValueOnce({ stoppedSessionIds: [] })

    const result = await runSleepWorktree('wt-1', 'local')
    expect(result[0]).toMatchObject({ completed: true, stoppedSessionIds: [] })
    expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it('does not run delayed panels or steal a newer selection after an explicit wake', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.activeWorkspaceExecutionHostId = 'local'
    const native = deferred<{ stoppedSessionIds: string[] }>()
    mocks.call.mockReturnValueOnce(native.promise)
    const sleep = runSleepWorktree('wt-1', 'local')
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
    clearWorktreeSleepIntent('wt-1', 'local')
    mocks.state.activeWorktreeId = 'wt-2'
    native.resolve({ stoppedSessionIds: ['session-1'] })
    expect((await sleep)[0].completed).toBe(false)
    expect(mocks.state.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    expect(mocks.state.activeWorktreeId).toBe('wt-2')
  })

  it('issues every host call before a slow sibling permits panel teardown', async () => {
    const first = deferred<{ stoppedSessionIds: string[] }>()
    const second = deferred<{ stoppedSessionIds: string[] }>()
    mocks.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const sleep = runSleepWorktrees([
      { id: 'wt-1', executionHostId: 'local' },
      { id: 'wt-2', executionHostId: 'local' }
    ])
    expect(mocks.call).toHaveBeenCalledTimes(2)
    expect(mocks.state.shutdownWorktreeBrowsers).not.toHaveBeenCalled()
    first.resolve({ stoppedSessionIds: ['one'] })
    second.resolve({ stoppedSessionIds: ['two'] })
    expect((await sleep).map((result) => result.stoppedSessionIds)).toEqual([['one'], ['two']])
  })

  it('routes an inherited folder lane to the host rendered for its project group', async () => {
    mocks.state.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        connectionId: null,
        executionHostId: null
      }
    ]
    mocks.state.projectGroups = [
      {
        id: 'group-1',
        connectionId: null,
        executionHostId: 'runtime:env-1'
      }
    ]
    const result = await runSleepWorktrees([{ id: 'folder:folder-1', hostId: 'local' }])
    expect(result[0].executionHostId).toBe('runtime:env-1')
    expect(mocks.target).toHaveBeenCalledWith('runtime:env-1')
  })

  it('uses the selected folder owner when two hosts publish the same folder id', async () => {
    mocks.state.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'local-group',
        connectionId: null,
        executionHostId: 'local'
      },
      {
        id: 'folder-1',
        projectGroupId: 'remote-group',
        connectionId: null,
        executionHostId: 'runtime:env-1'
      }
    ]
    mocks.state.projectGroups = [
      { id: 'local-group', connectionId: null, executionHostId: 'local' },
      { id: 'remote-group', connectionId: null, executionHostId: 'runtime:env-1' }
    ]

    const result = await runSleepWorktrees([{ id: 'folder:folder-1', hostId: 'runtime:env-1' }])
    expect(result[0].executionHostId).toBe('runtime:env-1')
    expect(mocks.target).toHaveBeenCalledWith('runtime:env-1')
  })

  it('clears a matching legacy selection before terminal shutdown', async () => {
    mocks.state.activeWorktreeId = 'wt-1'
    mocks.state.activeWorkspaceExecutionHostId = null
    mocks.state.worktreesByRepo = {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }]
    }
    mocks.state.shutdownWorktreeTerminals.mockImplementationOnce(async () => {
      expect(mocks.state.activeWorktreeId).toBeNull()
    })

    await runSleepWorktree('wt-1', 'local')
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(null)
  })

  it('invalidates an early completion when the workspace wakes during a slow sibling', async () => {
    const slow = deferred<{ stoppedSessionIds: string[] }>()
    mocks.call
      .mockResolvedValueOnce({ stoppedSessionIds: ['first'] })
      .mockReturnValueOnce(slow.promise)
    const sleep = runSleepWorktrees([
      { id: 'wt-1', executionHostId: 'local' },
      { id: 'wt-2', executionHostId: 'local' }
    ])
    await vi.waitFor(() =>
      expect(mocks.state.shutdownWorktreeTerminals).toHaveBeenCalledWith('wt-1', {
        keepIdentifiers: true
      })
    )
    clearWorktreeSleepIntent('wt-1', 'local')
    mocks.state.activeWorktreeId = 'wt-2'
    slow.resolve({ stoppedSessionIds: ['second'] })

    expect(await sleep).toEqual([
      {
        workspaceId: 'wt-1',
        executionHostId: 'local',
        stoppedSessionIds: ['first'],
        completed: false
      },
      {
        workspaceId: 'wt-2',
        executionHostId: 'local',
        stoppedSessionIds: ['second'],
        completed: true
      }
    ])
  })
})
