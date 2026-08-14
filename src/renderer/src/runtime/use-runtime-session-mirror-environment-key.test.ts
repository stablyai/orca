// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shallow } from 'zustand/shallow'
import { getDefaultSettings } from '../../../shared/constants'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type * as RuntimeSessionMirrorTargetsModule from '@/lib/runtime-session-mirror-targets'
import { makeWorktree } from '@/store/slices/store-test-helpers'

const { getMirrorTargets } = vi.hoisted(() => ({ getMirrorTargets: vi.fn() }))

vi.mock('@/lib/runtime-session-mirror-targets', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeSessionMirrorTargetsModule>()
  getMirrorTargets.mockImplementation(actual.getReachableRuntimeSessionMirrorTargets)
  return { ...actual, getReachableRuntimeSessionMirrorTargets: getMirrorTargets }
})

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import {
  selectRuntimeSessionMirrorTargetInputs,
  useRuntimeSessionMirrorEnvironmentKey
} from './use-runtime-session-mirror-environment-key'
import { useWebSessionTabsSync } from './web-session-tabs-sync'

const initialState = useAppStore.getInitialState()

function makeRepo(id: string, executionHostId: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    connectionId: null,
    executionHostId
  }
}

function makeProjectGroup(executionHostId: ProjectGroup['executionHostId']): ProjectGroup {
  return {
    id: 'group-b',
    name: 'Group B',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    connectionId: null,
    executionHostId
  }
}

function seedMirrorState(): void {
  useAppStore.setState(
    {
      ...initialState,
      settings: {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: 'env-a'
      },
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironments: [
        { id: 'env-a', createdAt: 100, pairingRevision: 101 },
        { id: 'env-b', createdAt: 200, pairingRevision: 201 }
      ] as PublicKnownRuntimeEnvironment[],
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-a',
          {
            status: { runtimeId: 'runtime-a' },
            connectionGeneration: 1
          }
        ],
        [
          'env-b',
          {
            status: { runtimeId: 'runtime-b' },
            connectionGeneration: 2
          }
        ]
      ]) as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
}

describe('useRuntimeSessionMirrorEnvironmentKey', () => {
  beforeEach(() => {
    getMirrorTargets.mockClear()
    seedMirrorState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('does not rescan remote ownership for unrelated store writes or parent renders', () => {
    const repos = Array.from({ length: 100 }, (_, index) =>
      makeRepo(`repo-${index}`, 'runtime:env-a')
    )
    const worktreesByRepo: AppState['worktreesByRepo'] = Object.fromEntries(
      repos.map((repo) => [
        repo.id,
        [
          makeWorktree({
            id: `${repo.id}::worktree`,
            repoId: repo.id,
            hostId: 'runtime:env-a'
          })
        ]
      ])
    )
    useAppStore.setState({ repos, worktreesByRepo })
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())
    const initialCallCount = getMirrorTargets.mock.calls.length

    expect(hook.result.current).toBe('env-a\u0001runtime-a\u00011\u0001101')
    expect(initialCallCount).toBe(1)

    act(() => {
      for (let index = 0; index < 100; index += 1) {
        useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      }
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          terminalFontSize: useAppStore.getState().settings!.terminalFontSize + 1
        }
      })
    })
    hook.rerender()

    expect(getMirrorTargets).toHaveBeenCalledTimes(initialCallCount)
  })

  it('keeps the production session sync off the hot store-write path', () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    const initialCallCount = getMirrorTargets.mock.calls.length

    expect(initialCallCount).toBe(1)
    act(() => {
      useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
      useAppStore.setState({ sortEpoch: useAppStore.getState().sortEpoch + 1 })
    })
    hook.rerender()

    expect(getMirrorTargets).toHaveBeenCalledTimes(initialCallCount)
  })

  it.each([
    {
      source: 'active environment',
      change: (state: AppState): Partial<AppState> => ({
        settings: { ...state.settings!, activeRuntimeEnvironmentId: 'env-b' }
      })
    },
    {
      source: 'repository host',
      change: (): Partial<AppState> => ({
        repos: [makeRepo('repo-b', 'runtime:env-b')]
      })
    },
    {
      source: 'published worktree owner',
      change: (): Partial<AppState> => ({
        worktreesByRepo: {
          'repo-b': [
            makeWorktree({
              id: 'repo-b::worktree',
              repoId: 'repo-b',
              hostId: 'ssh:private',
              runtimeOwnerEnvironmentId: 'env-b'
            })
          ]
        }
      })
    },
    {
      source: 'detected worktree owner',
      change: (): Partial<AppState> => ({
        detectedWorktreesByRepo: {
          'repo-b': {
            repoId: 'repo-b',
            authoritative: true,
            source: 'git',
            worktrees: [
              {
                ...makeWorktree({
                  id: 'repo-b::detected',
                  repoId: 'repo-b',
                  hostId: 'ssh:private',
                  runtimeOwnerEnvironmentId: 'env-b'
                }),
                ownership: 'external',
                selectedCheckout: false,
                visible: true
              }
            ]
          }
        }
      })
    },
    {
      source: 'project group host',
      change: (): Partial<AppState> => ({
        projectGroups: [makeProjectGroup('runtime:env-b')]
      })
    },
    {
      source: 'restored session host',
      change: (): Partial<AppState> => ({
        restoredRuntimeHostIdByWorkspaceSessionKey: { 'folder:restored': 'runtime:env-b' }
      })
    }
  ])('rebuilds when the $source selects an online runtime', ({ change }) => {
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        activeRuntimeEnvironmentId: null
      }
    })
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())

    expect(hook.result.current).toBe('')
    act(() => useAppStore.setState(change(useAppStore.getState())))

    expect(hook.result.current).toBe('env-b\u0001runtime-b\u00012\u0001201')
    expect(getMirrorTargets).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the key when connection or pairing identity changes', () => {
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())

    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [
            'env-a',
            {
              status: { runtimeId: 'runtime-a' },
              connectionGeneration: 2
            }
          ]
        ]) as AppState['runtimeStatusByEnvironmentId']
      })
    })
    expect(hook.result.current).toBe('env-a\u0001runtime-a\u00012\u0001101')

    act(() => {
      useAppStore.setState({
        runtimeEnvironments: [
          { id: 'env-a', createdAt: 100, pairingRevision: 102 }
        ] as PublicKnownRuntimeEnvironment[]
      })
    })
    expect(hook.result.current).toBe('env-a\u0001runtime-a\u00012\u0001102')
    expect(getMirrorTargets).toHaveBeenCalledTimes(3)
  })

  it('clears the key when status, environment, or the final owner disappears', () => {
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKey())
    const onlineStatus = useAppStore.getState().runtimeStatusByEnvironmentId.get('env-a')!
    const environments = useAppStore.getState().runtimeEnvironments

    act(() => {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['env-a', { ...onlineStatus, status: null }]])
      })
    })
    expect(hook.result.current).toBe('')

    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['env-a', onlineStatus]]) })
    })
    expect(hook.result.current).toBe('env-a\u0001runtime-a\u00011\u0001101')

    act(() => useAppStore.setState({ runtimeEnvironments: [] }))
    expect(hook.result.current).toBe('')

    act(() => useAppStore.setState({ runtimeEnvironments: environments }))
    expect(hook.result.current).toBe('env-a\u0001runtime-a\u00011\u0001101')

    act(() => {
      useAppStore.setState({
        settings: {
          ...useAppStore.getState().settings!,
          activeRuntimeEnvironmentId: null
        }
      })
    })
    expect(hook.result.current).toBe('')
    expect(getMirrorTargets).toHaveBeenCalledTimes(6)
  })

  it('invalidates only for state read by the mirror target builder', () => {
    const state = useAppStore.getState()
    const selected = selectRuntimeSessionMirrorTargetInputs(state)
    const unrelated = selectRuntimeSessionMirrorTargetInputs({
      ...state,
      agentStatusEpoch: state.agentStatusEpoch + 1,
      settings: { ...state.settings!, terminalFontSize: state.settings!.terminalFontSize + 1 }
    })

    expect(shallow(selected, unrelated)).toBe(true)

    const relevantChanges: Partial<AppState>[] = [
      { settings: { ...state.settings!, activeRuntimeEnvironmentId: 'env-b' } },
      { repos: [...state.repos] },
      { worktreesByRepo: { ...state.worktreesByRepo } },
      { detectedWorktreesByRepo: { ...state.detectedWorktreesByRepo } },
      { projectGroups: [...state.projectGroups] },
      {
        restoredRuntimeHostIdByWorkspaceSessionKey: {
          ...state.restoredRuntimeHostIdByWorkspaceSessionKey
        }
      },
      { runtimeEnvironments: [...state.runtimeEnvironments] },
      { runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId) }
    ]
    for (const change of relevantChanges) {
      expect(
        shallow(
          selected,
          selectRuntimeSessionMirrorTargetInputs({ ...state, ...change } as AppState)
        )
      ).toBe(false)
    }
  })
})
