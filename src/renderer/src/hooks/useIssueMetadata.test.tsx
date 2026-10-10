// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLinearMetadataCache,
  useRepoLabels,
  useRepoAssignees,
  useTeamStates,
  useTeamsStates
} from './useIssueMetadata'

const linearMocks = vi.hoisted(() => ({
  linearTeamStates: vi.fn(),
  linearTeamLabels: vi.fn(),
  linearTeamMembers: vi.fn()
}))

const runtimeMocks = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
const githubMocks = vi.hoisted(() => ({ listLabels: vi.fn(), listAssignableUsers: vi.fn() }))

vi.mock('@/runtime/runtime-linear-project-client', () => ({
  linearTeamStates: linearMocks.linearTeamStates,
  linearTeamLabels: linearMocks.linearTeamLabels,
  linearTeamMembers: linearMocks.linearTeamMembers
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtimeMocks.callRuntimeRpc,
  getActiveRuntimeTarget: (settings?: { activeRuntimeEnvironmentId?: string | null } | null) =>
    settings?.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))

const roots: Root[] = []

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        listLabels: githubMocks.listLabels,
        listAssignableUsers: githubMocks.listAssignableUsers
      }
    }
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderProbe(element: React.ReactNode): void {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(element)
  })
}

describe('useIssueMetadata hooks', () => {
  beforeEach(() => {
    clearLinearMetadataCache()
    linearMocks.linearTeamStates.mockReset()
    linearMocks.linearTeamLabels.mockReset()
    linearMocks.linearTeamMembers.mockReset()
    runtimeMocks.callRuntimeRpc.mockReset()
    githubMocks.listLabels.mockReset()
    githubMocks.listAssignableUsers.mockReset()
    installWindowApi()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('routes repo-id-only folder metadata through local IPC', async () => {
    let labels: string[] = []
    githubMocks.listLabels.mockResolvedValue(['folder'])

    function LabelsProbe(): null {
      labels = useRepoLabels(null, 'folder-repo-id').data
      return null
    }

    renderProbe(<LabelsProbe />)
    await flushEffects()

    expect(labels).toEqual(['folder'])
    expect(githubMocks.listLabels).toHaveBeenCalledExactlyOnceWith({
      repoPath: '',
      repoId: 'folder-repo-id'
    })
    expect(runtimeMocks.callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps concurrent fork and upstream label lists separate when the fork reply is late', async () => {
    const fork = { owner: 'fork', repo: 'widgets', host: 'github.com' }
    const upstream = { owner: 'upstream', repo: 'widgets', host: 'github.com' }
    let finishFork: (labels: string[]) => void = () => {}
    const forkReply = new Promise<string[]>((resolve) => {
      finishFork = resolve
    })
    githubMocks.listLabels.mockImplementation(({ ownerRepo }) =>
      ownerRepo.owner === 'fork' ? forkReply : Promise.resolve(['upstream-label'])
    )
    let forkLabels: string[] = []
    let upstreamLabels: string[] = []
    function Probe(): null {
      forkLabels = useRepoLabels(null, 'concurrent-folder', { ownerRepo: fork }).data
      upstreamLabels = useRepoLabels(null, 'concurrent-folder', { ownerRepo: upstream }).data
      return null
    }
    renderProbe(<Probe />)
    await flushEffects()
    expect(forkLabels).toEqual([])
    expect(upstreamLabels).toEqual(['upstream-label'])
    await act(async () => {
      finishFork(['fork-label'])
    })
    await flushEffects()
    expect(forkLabels).toEqual(['fork-label'])
    expect(upstreamLabels).toEqual(['upstream-label'])
    expect(githubMocks.listLabels).toHaveBeenCalledTimes(2)
  })

  it('ignores a late fork assignee reply after the opened issue switches to upstream', async () => {
    const fork = { owner: 'fork', repo: 'widgets', host: 'github.com' }
    const upstream = { owner: 'upstream', repo: 'widgets', host: 'github.com' }
    let finishFork: (users: { login: string; name: null; avatarUrl: string }[]) => void = () => {}
    const forkReply = new Promise<{ login: string; name: null; avatarUrl: string }[]>((resolve) => {
      finishFork = resolve
    })
    githubMocks.listAssignableUsers.mockImplementation(({ ownerRepo }) =>
      ownerRepo.owner === 'fork'
        ? forkReply
        : Promise.resolve([{ login: 'upstream-user', name: null, avatarUrl: '' }])
    )
    let logins: string[] = []
    function Probe({ ownerRepo }: { ownerRepo: typeof fork }): null {
      logins = useRepoAssignees(null, 'switch-folder', { ownerRepo }).data.map((user) => user.login)
      return null
    }
    renderProbe(<Probe ownerRepo={fork} />)
    await flushEffects()
    const root = roots.at(-1)
    if (!root) {
      throw new Error('Expected the rendered probe')
    }
    act(() => root.render(<Probe ownerRepo={upstream} />))
    await flushEffects()
    expect(logins).toEqual(['upstream-user'])
    await act(async () => {
      finishFork([{ login: 'fork-user', name: null, avatarUrl: '' }])
    })
    await flushEffects()
    expect(logins).toEqual(['upstream-user'])
    expect(githubMocks.listAssignableUsers).toHaveBeenCalledTimes(2)
  })

  it('prefers an explicit remote environment and repo id', async () => {
    let labels: string[] = []
    runtimeMocks.callRuntimeRpc.mockResolvedValue(['remote'])

    function LabelsProbe(): null {
      labels = useRepoLabels('/local/repo', 'remote-repo-id', {
        target: { kind: 'environment', environmentId: 'env-explicit' }
      }).data
      return null
    }

    renderProbe(<LabelsProbe />)
    await flushEffects()

    expect(labels).toEqual(['remote'])
    expect(runtimeMocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
      { kind: 'environment', environmentId: 'env-explicit' },
      'github.listLabels',
      { repo: 'remote-repo-id' },
      { timeoutMs: 15_000 }
    )
    expect(githubMocks.listLabels).not.toHaveBeenCalled()
  })

  it('does not loop when cached team-state metadata is read with a fresh settings object', async () => {
    let renders = 0
    let states: unknown[] = []
    linearMocks.linearTeamStates.mockResolvedValue([{ id: 's1', name: 'Todo' }])

    function StatesProbe(): null {
      renders += 1
      // Fresh settings object each render — the storm trigger.
      const metadata = useTeamStates('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      states = metadata.data
      return null
    }

    renderProbe(<StatesProbe />)
    await flushEffects()

    expect(states).toEqual([{ id: 's1', name: 'Todo' }])
    expect(linearMocks.linearTeamStates).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('does not re-issue a failed team-state fetch when a fresh settings object re-renders', async () => {
    let renders = 0
    let error: string | null = null
    linearMocks.linearTeamStates.mockRejectedValue(new Error('Could not connect'))

    function StatesProbe(): null {
      renders += 1
      const metadata = useTeamStates('team-1', { activeRuntimeEnvironmentId: null }, 'ws-1')
      error = metadata.error
      return null
    }

    renderProbe(<StatesProbe />)
    await flushEffects()
    await flushEffects()
    await flushEffects()

    expect(error).toBe('Could not connect')
    expect(linearMocks.linearTeamStates).toHaveBeenCalledTimes(1)
    expect(renders).toBeLessThanOrEqual(4)
  })

  it('unions workflow states across every selected team (#8739)', async () => {
    let states: { id: string; name: string }[] = []
    linearMocks.linearTeamStates.mockImplementation(async (_settings, teamId: string) => {
      if (teamId === 'team-be') {
        return [
          { id: 'be-todo', name: 'Todo' },
          { id: 'be-done', name: 'Done' }
        ]
      }
      if (teamId === 'team-fe') {
        return [
          { id: 'fe-todo', name: 'Todo' },
          { id: 'fe-review', name: 'In Review' }
        ]
      }
      return []
    })

    function MultiProbe(): null {
      const metadata = useTeamsStates(
        ['team-fe', 'team-be'],
        { activeRuntimeEnvironmentId: null },
        'ws-1'
      )
      states = metadata.data as { id: string; name: string }[]
      return null
    }

    renderProbe(<MultiProbe />)
    await flushEffects()
    await flushEffects()

    expect(linearMocks.linearTeamStates).toHaveBeenCalledTimes(2)
    expect(states.map((s) => s.id).sort()).toEqual(['be-done', 'be-todo', 'fe-review', 'fe-todo'])
  })
})
