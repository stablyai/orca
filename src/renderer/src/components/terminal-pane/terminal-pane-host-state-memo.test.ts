// @vitest-environment happy-dom
// useShallow skips renders, not selectors; memoize host resolution to avoid per-tab traversal and discarded objects on every publication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type * as LocalRuntime from '@/lib/local-preflight-context'
import type * as ConnectionContext from '@/lib/connection-context'
import type { AppState } from '@/store/types'
import {
  resetTerminalPaneHostStateMemoForTests,
  selectNativeChatWslProject,
  selectTerminalPaneHostState
} from './terminal-pane-host-state'

const connectionIdCalls = vi.hoisted(() => ({ count: 0 }))
const runtimeCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))
vi.mock('@/lib/local-preflight-context', async (original) => {
  const actual = await original<typeof LocalRuntime>()
  return {
    ...actual,
    getLocalProjectExecutionRuntimeContext: (
      ...args: Parameters<typeof actual.getLocalProjectExecutionRuntimeContext>
    ) => {
      runtimeCalls.count++
      return actual.getLocalProjectExecutionRuntimeContext(...args)
    }
  }
})
afterEach(cleanup)

vi.mock('@/lib/connection-context', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionContext>()
  return {
    ...actual,
    getConnectionIdFromState: (state: AppState, worktreeId: string | null) => {
      connectionIdCalls.count += 1
      return actual.getConnectionIdFromState(state, worktreeId)
    }
  }
})

const LOCAL_WORKTREE = 'repo-1::/repo/worktrees/local'
const OTHER_WORKTREE = 'repo-2::/repo/worktrees/other'

/** Only the fields the resolver touches; the memo key is the whole object. */
function makeState(overrides: Partial<Record<string, unknown>> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    sshTargetLabels: new Map(),
    removedSshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    sshTargets: [],
    ...overrides
  } as unknown as AppState
}

beforeEach(() => {
  resetTerminalPaneHostStateMemoForTests()
  connectionIdCalls.count = 0
})

describe('selectTerminalPaneHostState memo', () => {
  it('releases the last store snapshot when no terminal selects again', async () => {
    if (typeof globalThis.gc !== 'function') {
      throw new Error('Run with the repository Vitest --expose-gc config')
    }
    function selectRetiredState(): WeakRef<AppState> {
      const state = makeState()
      selectTerminalPaneHostState(state, LOCAL_WORKTREE)
      return new WeakRef(state)
    }
    const retired = selectRetiredState()
    for (let round = 0; round < 3; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      globalThis.gc()
    }
    expect(retired.deref()).toBeUndefined()
  })

  it('returns the same object across an unrelated store write', () => {
    const first = makeState()
    const before = selectTerminalPaneHostState(first, LOCAL_WORKTREE)

    const second = makeState({ rightSidebarOpen: true })
    const after = selectTerminalPaneHostState(second, LOCAL_WORKTREE)

    expect(after).toBe(before)
  })

  it('resolves the host once per published state, not once per mounted tab', () => {
    const state = makeState()
    selectTerminalPaneHostState(state, LOCAL_WORKTREE)
    const afterFirstTab = connectionIdCalls.count
    expect(afterFirstTab).toBe(1)

    for (let index = 0; index < 4; index += 1) {
      selectTerminalPaneHostState(state, LOCAL_WORKTREE)
    }
    expect(connectionIdCalls.count).toBe(afterFirstTab)

    selectTerminalPaneHostState(state, OTHER_WORKTREE)
    expect(connectionIdCalls.count).toBe(afterFirstTab + 1)
  })

  it('re-resolves when the published state changes, so a host change is never stale', () => {
    const local = makeState()
    const before = selectTerminalPaneHostState(local, LOCAL_WORKTREE)
    expect(before.sshReconnectTargetId).toBeNull()

    const remote = makeState({
      repos: [{ id: 'repo-1', path: '/repo', connectionId: 'ssh-host-a' }],
      worktreesByRepo: {
        'repo-1': [{ id: LOCAL_WORKTREE, repoId: 'repo-1', path: '/repo/worktrees/local' }]
      }
    })
    const after = selectTerminalPaneHostState(remote, LOCAL_WORKTREE)

    expect(after).not.toBe(before)
    expect(after.sshReconnectTargetId).toBe('ssh-host-a')
  })

  it('allocates nothing across 1,000 publications at 6 worktrees x 5 tabs', () => {
    const worktreeIds = Array.from({ length: 6 }, (_, index) => `repo-${index}::/repo/wt-${index}`)
    const firstState = makeState()
    const firstByWorktree = new Map(
      worktreeIds.map((worktreeId) => [
        worktreeId,
        selectTerminalPaneHostState(firstState, worktreeId)
      ])
    )
    connectionIdCalls.count = 0
    let allocations = 0

    for (let publication = 0; publication < 1_000; publication += 1) {
      const state = makeState({ agentStatusEpoch: publication })
      for (const worktreeId of worktreeIds) {
        for (let tab = 0; tab < 5; tab += 1) {
          if (selectTerminalPaneHostState(state, worktreeId) !== firstByWorktree.get(worktreeId)) {
            allocations += 1
          }
        }
      }
    }

    expect(allocations).toBe(0)
    expect(connectionIdCalls.count).toBe(6 * 1_000)
  })
})

describe('native chat production subscriptions at scale', () => {
  it.each([10, 100])(
    'indexes %s workspaces once and isolates settled publications from renders',
    (count) => {
      let projectVisits = 0
      let ownerVisits = 0
      const projects = Array.from({ length: count }, (_, i) => ({
        id: `repo-${i}`,
        get sourceRepoIds() {
          projectVisits++
          return []
        },
        displayName: '',
        badgeColor: '',
        createdAt: 0,
        updatedAt: 0
      }))
      const worktreesByRepo = Object.fromEntries(
        projects.map((p) => [
          p.id,
          [
            {
              ...makeWorktree({
                id: p.id,
                repoId: p.id,
                hostId: 'local',
                path: '//wsl.localhost/Ubuntu/work'
              }),
              get id() {
                ownerVisits++
                return p.id
              },
              repoId: p.id,
              hostId: 'local' as const,
              path: '//wsl.localhost/Ubuntu/work'
            }
          ]
        ])
      )
      const state = makeState({
        projects,
        worktreesByRepo,
        repos: projects.map((p) => ({ id: p.id, executionHostId: 'local', path: 'C:/repo' })),
        settings: createGlobalSettingsFixture({
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      })
      useAppStore.setState(state)
      runtimeCalls.count = 0
      const renders = new Map<string, number>()
      const subscribers = projects.flatMap((p) =>
        Array.from({ length: 4 }, (_, subscriber) => {
          const key = `${p.id}:${subscriber}`
          return renderHook(() => {
            // The retained pane and tab-bar production selectors; three panes share each addressed fact.
            const value = useAppStore((s) =>
              subscriber === 3
                ? selectNativeChatWslProject(s, p.id)
                : selectTerminalPaneHostState(s, p.id).nativeChatIsWslProject
            )
            renders.set(key, (renders.get(key) ?? 0) + 1)
            return value
          })
        })
      )
      expect(projectVisits).toBe(count)
      expect(runtimeCalls.count).toBe(count)
      expect(ownerVisits).toBeGreaterThanOrEqual(count)
      expect(ownerVisits).toBeLessThanOrEqual(20 * count)
      const initialOwnerVisits = ownerVisits
      const settled = new Map(renders)
      const noWork = () => {
        expect(ownerVisits).toBe(initialOwnerVisits)
        expect(projectVisits).toBe(count)
        expect(runtimeCalls.count).toBe(count)
        expect(renders).toEqual(settled)
      }
      act(() => useAppStore.setState({ rightSidebarOpen: true }))
      noWork()
      act(() =>
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
            [
              'another-host',
              {
                status: {
                  ...createCompatibleRuntimeStatusResponse('another-host').result,
                  hostPlatform: 'linux'
                },
                checkedAt: 1
              }
            ]
          ])
        })
      )
      noWork()
      act(() =>
        useAppStore.setState({
          worktreesByRepo: {
            ...worktreesByRepo,
            'repo-0': [{ ...worktreesByRepo['repo-0'][0], path: 'C:/native' }]
          }
        })
      )
      expect(ownerVisits).toBeLessThanOrEqual(initialOwnerVisits + 3 * count)
      expect(projectVisits).toBe(count)
      expect(runtimeCalls.count).toBe(count + 1)
      expect(subscribers.slice(0, 4).map((h) => h.result.current)).toEqual([
        false,
        false,
        false,
        false
      ])
      for (const [key, value] of settled) {
        expect(renders.get(key)).toBe(value + (key.startsWith('repo-0:') ? 1 : 0))
      }
      subscribers.forEach((h) => h.unmount())
    }
  )
})
