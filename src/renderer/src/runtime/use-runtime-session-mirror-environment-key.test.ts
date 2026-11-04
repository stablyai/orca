// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zustand/shallow'
import { getDefaultSettings } from '../../../shared/constants'

import type { Repo } from '../../../shared/repo-types'
import type * as RuntimeSessionMirrorTargetsModule from '@/lib/runtime-session-mirror-targets'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'

const { getMirrorTargets } = vi.hoisted(() => ({ getMirrorTargets: vi.fn() }))

vi.mock('@/lib/runtime-session-mirror-targets', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeSessionMirrorTargetsModule>()
  getMirrorTargets.mockImplementation(actual.getReachableRuntimeSessionMirrorTargets)
  return { ...actual, getReachableRuntimeSessionMirrorTargets: getMirrorTargets }
})

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useRuntimeSessionMirrorEnvironmentKeys } from './use-runtime-session-mirror-environment-key'
import { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from './paired-runtime-environment-test-fixture'

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
        publicRuntimeEnvironment({ id: 'env-a', createdAt: 100, pairingRevision: 101 }),
        publicRuntimeEnvironment({ id: 'env-b', createdAt: 200, pairingRevision: 201 })
      ],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', connectedRuntimeStatus('runtime-a', 1)],
        ['env-b', connectedRuntimeStatus('runtime-b', 2)]
      ])
    },
    true
  )
}

describe('useRuntimeSessionMirrorEnvironmentKeys', () => {
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
    const hook = renderHook(() => useRuntimeSessionMirrorEnvironmentKeys())
    const initialCallCount = getMirrorTargets.mock.calls.length

    expect(hook.result.current.environmentKey).toBe('env-a\u0001runtime-a\u00011\u0001101')
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
})
