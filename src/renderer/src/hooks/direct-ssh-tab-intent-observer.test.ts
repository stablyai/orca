import { describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceTabObservation } from '../../../shared/remote-workspace-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'
import { createDirectSshTabIntentObserver } from './direct-ssh-tab-intent-observer'

const WT_A = 'repo-a::/remote/a'
const WT_B = 'repo-b::/remote/b'

function tab(id: string, worktreeId: string, title = id): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: `pty-${id}`,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function state(): AppState {
  return {
    repos: [
      {
        id: 'repo-a',
        path: '/remote/a',
        projectGroupId: null,
        connectionId: 'target-a',
        executionHostId: 'ssh:target-a'
      },
      {
        id: 'repo-b',
        path: '/remote/b',
        projectGroupId: null,
        connectionId: 'target-b',
        executionHostId: 'ssh:target-b'
      }
    ],
    worktreesByRepo: {
      'repo-a': [{ id: WT_A, repoId: 'repo-a', hostId: 'ssh:target-a', instanceId: 'instance-a' }],
      'repo-b': [{ id: WT_B, repoId: 'repo-b', hostId: 'ssh:target-b', instanceId: 'instance-b' }]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    sshTargetLabels: new Map([
      ['target-a', 'A'],
      ['target-b', 'B']
    ]),
    sshConnectionStates: new Map(),
    remoteWorkspaceHydratedTargetIds: new Set(['target-a', 'target-b']),
    tabsByWorktree: {
      [WT_A]: [tab('a-old', WT_A)],
      [WT_B]: [tab('b-old', WT_B)]
    },
    ptyIdsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    terminalLayoutsByTabId: {},
    terminalPtyIncarnationsByPaneKey: {},
    remoteSessionIdsByTabId: {}
  } as unknown as AppState
}

function harness() {
  const observeTabState = vi.fn(async (_observation: RemoteWorkspaceTabObservation) => {})
  const forgetTabState = vi.fn(async () => {})
  const forgetAllTabState = vi.fn(async () => {})
  const startTabStateObservation = vi.fn(async () => 1)
  const scanned: string[] = []
  return {
    forgetAllTabState,
    forgetTabState,
    observeTabState,
    observer: createDirectSshTabIntentObserver(
      { forgetAllTabState, forgetTabState, observeTabState, startTabStateObservation },
      { onTargetScanned: (targetId) => scanned.push(targetId), rendererGeneration: 1 }
    ),
    scanned
  }
}

describe('createDirectSshTabIntentObserver', () => {
  it('waits for the main-issued renderer generation before publishing state', async () => {
    let resolveGeneration!: (generation: number) => void
    const observeTabState = vi.fn(async () => {})
    const observer = createDirectSshTabIntentObserver({
      forgetAllTabState: vi.fn(async () => {}),
      forgetTabState: vi.fn(async () => {}),
      observeTabState,
      startTabStateObservation: () =>
        new Promise<number>((resolve) => {
          resolveGeneration = resolve
        })
    })

    observer.observeState(state())
    expect(observeTabState).not.toHaveBeenCalled()
    resolveGeneration(9)

    await vi.waitFor(() =>
      expect(observeTabState).toHaveBeenCalledWith(
        expect.objectContaining({ rendererGeneration: 9 })
      )
    )
  })

  it('sends topology changes only to the owning target and ignores live title churn', () => {
    const base = state()
    const { observer, observeTabState, scanned } = harness()
    observer.observeState(base)
    observeTabState.mockClear()
    scanned.length = 0

    const created = {
      ...base,
      tabsByWorktree: {
        ...base.tabsByWorktree,
        [WT_A]: [...base.tabsByWorktree[WT_A], tab('a-new', WT_A)]
      }
    }
    observer.observeState(created)
    expect(scanned).toEqual(['target-a'])
    expect(observeTabState).toHaveBeenCalledTimes(1)

    observeTabState.mockClear()
    scanned.length = 0
    observer.observeState({
      ...created,
      tabsByWorktree: {
        ...created.tabsByWorktree,
        [WT_A]: created.tabsByWorktree[WT_A].map((entry) => ({
          ...entry,
          title: `${entry.title} spinner`
        }))
      }
    })
    expect(scanned).toEqual(['target-a'])
    expect(observeTabState).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'split-pane layout',
      update: (base: AppState): AppState => ({
        ...base,
        terminalLayoutsByTabId: {
          ...base.terminalLayoutsByTabId,
          'a-old': {
            activeLeafId: null,
            expandedLeafId: null,
            ptyIdsByLeafId: { leaf: 'pty-split' },
            root: null
          }
        }
      })
    },
    {
      name: 'tab PTY binding',
      update: (base: AppState): AppState => ({
        ...base,
        ptyIdsByTabId: { ...base.ptyIdsByTabId, 'a-old': ['pty-bound'] }
      })
    },
    {
      name: 'relay PTY binding',
      update: (base: AppState): AppState => ({
        ...base,
        lastKnownRelayPtyIdByTabId: {
          ...base.lastKnownRelayPtyIdByTabId,
          'a-old': 'pty-relay'
        }
      })
    }
  ])('publishes $name changes only to the owning target', ({ update }) => {
    const base = state()
    const { observer, observeTabState, scanned } = harness()
    observer.observeState(base)
    const initialIdentity =
      observeTabState.mock.calls[0]?.[0]?.worktrees[0]?.tabs[0]?.processIdentity
    observeTabState.mockClear()
    scanned.length = 0

    observer.observeState(update(base))

    expect(scanned).toEqual(['target-a'])
    expect(observeTabState).toHaveBeenCalledOnce()
    const observation = observeTabState.mock.calls[0]?.[0]
    expect(observation?.targetId).toBe('target-a')
    expect(observation?.worktrees[0]?.tabs[0]?.processIdentity).not.toBe(initialIdentity)
  })

  it('scans one owner, not every configured target, for title churn at 1,000-target scale', () => {
    const targetCount = 1_000
    const repos = Array.from({ length: targetCount }, (_, index) => ({
      id: `repo-${index}`,
      path: `/remote/${index}`,
      projectGroupId: null,
      connectionId: `target-${index}`,
      executionHostId: `ssh:target-${index}`
    }))
    const worktreesByRepo = Object.fromEntries(
      repos.map((repo, index) => [
        repo.id,
        [
          {
            id: `${repo.id}::/remote/${index}`,
            repoId: repo.id,
            hostId: repo.executionHostId,
            instanceId: `instance-${index}`
          }
        ]
      ])
    )
    const tabsByWorktree = Object.fromEntries(
      repos.map((repo, index) => {
        const worktreeId = `${repo.id}::/remote/${index}`
        return [worktreeId, [tab(`tab-${index}`, worktreeId)]]
      })
    )
    const scaled = {
      ...state(),
      repos,
      worktreesByRepo,
      sshTargetLabels: new Map(repos.map((_, index) => [`target-${index}`, `${index}`])),
      remoteWorkspaceHydratedTargetIds: new Set(repos.map((_, index) => `target-${index}`)),
      tabsByWorktree
    } as unknown as AppState
    const { observer, observeTabState, scanned } = harness()
    observer.observeState(scaled)
    observeTabState.mockClear()
    scanned.length = 0

    const changedWorktreeId = 'repo-500::/remote/500'
    observer.observeState({
      ...scaled,
      tabsByWorktree: {
        ...scaled.tabsByWorktree,
        [changedWorktreeId]: scaled.tabsByWorktree[changedWorktreeId].map((entry) => ({
          ...entry,
          title: 'spinner-only'
        }))
      }
    })

    expect(scanned).toEqual(['target-500'])
    expect(observeTabState).not.toHaveBeenCalled()

    scanned.length = 0
    observer.observeState({
      ...scaled,
      sshConnectionStates: new Map([['target-500', { status: 'connected' }]])
    } as unknown as AppState)
    expect(scanned).toEqual(['target-500'])
    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, targetId: 'target-500' })
    )
  })

  it('publishes 1,000 initial target observations within the observer latency budget', () => {
    const targetCount = 1_000
    const repos = Array.from({ length: targetCount }, (_, index) => ({
      id: `repo-${index}`,
      path: `/remote/${index}`,
      projectGroupId: null,
      connectionId: `target-${index}`,
      executionHostId: `ssh:target-${index}`
    }))
    const worktreesByRepo = Object.fromEntries(
      repos.map((repo, index) => [
        repo.id,
        [
          {
            id: `${repo.id}::/remote/${index}`,
            repoId: repo.id,
            hostId: repo.executionHostId,
            instanceId: `instance-${index}`
          }
        ]
      ])
    )
    const scaled = {
      ...state(),
      repos,
      worktreesByRepo,
      sshTargetLabels: new Map(repos.map((_, index) => [`target-${index}`, `${index}`])),
      remoteWorkspaceHydratedTargetIds: new Set(repos.map((_, index) => `target-${index}`)),
      tabsByWorktree: {}
    } as unknown as AppState
    const { observer, observeTabState } = harness()

    const startedAt = performance.now()
    observer.observeState(scaled)
    const elapsedMs = performance.now() - startedAt

    expect(observeTabState).toHaveBeenCalledTimes(targetCount)
    expect(elapsedMs).toBeLessThan(750)
  })

  it('publishes only the transitioned target when SSH connectedness changes', () => {
    const base = state()
    const { observer, observeTabState, scanned } = harness()
    observer.observeState(base)
    observeTabState.mockClear()
    scanned.length = 0

    const connected = {
      ...base,
      sshConnectionStates: new Map([
        ['target-a', { status: 'connected' }],
        ['target-b', { status: 'disconnected' }]
      ])
    } as unknown as AppState
    observer.observeState(connected)

    expect(scanned).toEqual(['target-a'])
    expect(observeTabState).toHaveBeenCalledOnce()
    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ connected: true, targetId: 'target-a' })
    )

    observeTabState.mockClear()
    scanned.length = 0
    observer.observeState({
      ...connected,
      sshConnectionStates: new Map([
        ['target-a', { status: 'disconnected' }],
        ['target-b', { status: 'disconnected' }]
      ])
    } as unknown as AppState)

    expect(scanned).toEqual(['target-a'])
    expect(observeTabState).toHaveBeenCalledOnce()
    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ connected: false, targetId: 'target-a' })
    )
  })

  it('publishes snapshot hydration as an authoritative baseline after the apply bracket', () => {
    const base = state()
    const { observer, observeTabState } = harness()
    observer.observeState(base)
    observeTabState.mockClear()

    const finish = observer.beginSnapshotApply('target-a')
    observer.observeState({
      ...base,
      tabsByWorktree: { ...base.tabsByWorktree, [WT_A]: [tab('remote', WT_A)] }
    })
    expect(observeTabState).not.toHaveBeenCalled()
    finish()

    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritative: true, targetId: 'target-a' })
    )
  })

  it('marks observations unhydrated until the target snapshot handshake completes', () => {
    const base = state()
    const { observer, observeTabState } = harness()
    observer.observeState({ ...base, remoteWorkspaceHydratedTargetIds: new Set() })
    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ hydrated: false, rendererGeneration: 1, targetId: 'target-a' })
    )

    observeTabState.mockClear()
    observer.observeState({
      ...base,
      remoteWorkspaceHydratedTargetIds: new Set(['target-a', 'target-b'])
    })
    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({ hydrated: true, rendererGeneration: 1, targetId: 'target-a' })
    )
  })

  it('reports a new immutable worktree identity even when path and tab ids are reused', () => {
    const base = state()
    const { observer, observeTabState } = harness()
    observer.observeState(base)
    observeTabState.mockClear()

    observer.observeState({
      ...base,
      worktreesByRepo: {
        ...base.worktreesByRepo,
        'repo-a': [{ ...base.worktreesByRepo['repo-a'][0], instanceId: 'instance-a-2' }]
      }
    })

    expect(observeTabState).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'target-a',
        worktrees: [expect.objectContaining({ worktreeInstanceId: 'instance-a-2' })]
      })
    )
  })

  it('clears removed target state without disturbing retained targets', () => {
    const base = state()
    const { observer, forgetTabState } = harness()
    observer.observeState(base)

    observer.observeState({
      ...base,
      repos: base.repos.filter((repo) => repo.id !== 'repo-a'),
      worktreesByRepo: { 'repo-b': base.worktreesByRepo['repo-b'] },
      sshTargetLabels: new Map([['target-b', 'B']]),
      remoteWorkspaceHydratedTargetIds: new Set(['target-b'])
    })

    expect(forgetTabState).toHaveBeenCalledWith({ rendererGeneration: 1, targetId: 'target-a' })
    expect(forgetTabState).not.toHaveBeenCalledWith({
      rendererGeneration: 1,
      targetId: 'target-b'
    })
  })

  it('clears secondary overflow only after the configured target set becomes empty', () => {
    const base = state()
    const { observer, forgetAllTabState } = harness()
    observer.observeState(base)

    observer.observeState({
      ...base,
      repos: [],
      worktreesByRepo: {},
      sshTargetLabels: new Map(),
      remoteWorkspaceHydratedTargetIds: new Set()
    })

    expect(forgetAllTabState).toHaveBeenCalledOnce()
    expect(forgetAllTabState).toHaveBeenCalledWith({ rendererGeneration: 1 })
  })
})
