// @vitest-environment happy-dom
// useShallow skips renders, not selectors; memoize host resolution to avoid per-tab traversal and discarded objects on every publication.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import type * as LocalRuntime from '@/lib/local-preflight-context'
import type { AppState } from '@/store/types'
import {
  resetTerminalPaneHostStateMemoForTests,
  selectNativeChatWslProject,
  selectTerminalPaneHostState
} from './terminal-pane-host-state'

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

const LOCAL_WORKTREE = 'repo-1::/repo/worktrees/local'

/** Only the fields the resolver touches; the memo key is the whole object. */
function makeState(overrides: Partial<Record<string, unknown>> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
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

describe('qualified native chat runtime facts', () => {
  const path = '//wsl.localhost/Ubuntu/home/me/project'
  const settings = createGlobalSettingsFixture({
    localWindowsRuntimeDefault: { kind: 'windows-host' }
  })

  it.each([0, 1, 2])('resolves a local WSL folder with %s associated repos', (count) => {
    const state = makeState({
      settings,
      projects: [],
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
      ],
      projectGroups: [{ id: 'group' }],
      repos: Array.from({ length: count }, (_, i) => ({
        id: `repo-${i}`,
        path,
        projectGroupId: 'group'
      }))
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(true)
  })

  it.each(['windows-host', 'wsl'] as const)(
    'honors the %s default on an ordinary repo-free Windows folder',
    (kind) => {
      const state = makeState({
        projects: [],
        settings: createGlobalSettingsFixture({
          localWindowsRuntimeDefault: { kind, distro: 'Ubuntu' }
        }),
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'folder', folderPath: 'C:/folder', executionHostId: 'local' })
        ]
      })
      expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(kind === 'wsl')
    }
  )

  it('preserves explicit preference precedence, repair and late settings/project/path changes', () => {
    const folder = makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
    const state = makeState({
      settings,
      projects: [{ id: 'repo', localWindowsRuntimePreference: { kind: 'windows-host' } }],
      folderWorkspaces: [folder],
      projectGroups: [{ id: 'group' }],
      repos: [{ id: 'repo', path, projectGroupId: 'group' }]
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(false)
    const inherit = { ...state, projects: [] }
    expect(selectNativeChatWslProject(inherit, 'folder:folder')).toBe(true)
    const ordinary = { ...inherit, folderWorkspaces: [{ ...folder, folderPath: 'C:/folder' }] }
    expect(selectNativeChatWslProject(ordinary, 'folder:folder')).toBe(false)
    expect(
      selectNativeChatWslProject(
        {
          ...ordinary,
          settings: createGlobalSettingsFixture({
            localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
          })
        },
        'folder:folder'
      )
    ).toBeNull()
    expect(
      selectNativeChatWslProject(
        {
          ...ordinary,
          settings: createGlobalSettingsFixture({
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
          })
        },
        'folder:folder'
      )
    ).toBe(true)
  })

  it.each(['worktree', 'folder'] as const)(
    'uses the selected %s path with inherited paired ownership and late platform/path',
    (kind) => {
      const id = kind === 'folder' ? 'folder:folder' : 'wt'
      const state = makeState({
        repos: [{ id: 'repo', executionHostId: 'runtime:windows' }],
        projectGroups: [{ id: 'group', executionHostId: 'runtime:windows' }],
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
        ],
        worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path })] }
      })
      expect(selectNativeChatWslProject(state, id)).toBeNull()
      const answered = {
        ...state,
        runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
          [
            'windows',
            {
              status: {
                ...createCompatibleRuntimeStatusResponse('windows').result,
                hostPlatform: 'win32'
              },
              checkedAt: 1
            }
          ]
        ])
      }
      expect(selectNativeChatWslProject(answered, id)).toBe(true)
      expect(selectTerminalPaneHostState(answered, id).nativeChatIsWslProject).toBe(true)
      const nativePath = {
        ...answered,
        folderWorkspaces: answered.folderWorkspaces.map((f) => ({ ...f, folderPath: 'C:/folder' })),
        worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: 'C:/folder' })] }
      }
      expect(selectNativeChatWslProject(nativePath, id)).toBeNull()
    }
  )

  it('waits for a local Windows path instead of retiring from an incomplete row', () => {
    const state = makeState({
      settings,
      projects: [],
      repos: [{ id: 'repo', executionHostId: 'local' }],
      worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: '' })] }
    })
    expect(selectNativeChatWslProject(state, 'wt')).toBeNull()
    expect(
      selectNativeChatWslProject(
        { ...state, worktreesByRepo: { repo: [{ ...state.worktreesByRepo.repo[0], path }] } },
        'wt'
      )
    ).toBe(true)
  })

  it.each([false, true])('keeps folder and group twins qualified (remote-first %s)', (reverse) => {
    const local = makeFolderWorkspace({
      id: 'folder',
      projectGroupId: 'group',
      executionHostId: 'local',
      folderPath: path
    })
    const remote = { ...local, executionHostId: 'runtime:windows', folderPath: 'C:/remote' }
    const groups = [
      { id: 'group', executionHostId: 'local' },
      { id: 'group', executionHostId: 'runtime:windows' }
    ]
    const state = makeState({
      settings,
      projects: [],
      activeWorktreeId: 'folder:folder',
      activeWorkspaceExecutionHostId: 'local',
      folderWorkspaces: reverse ? [remote, local] : [local, remote],
      projectGroups: reverse ? groups.toReversed() : groups
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(true)
    expect(
      selectNativeChatWslProject(
        { ...state, activeWorkspaceExecutionHostId: null },
        'folder:folder'
      )
    ).toBeNull()
  })

  it.each([false, true])(
    'keeps preferred-local workspace/repo/project twins qualified (remote-first %s)',
    (reverse) => {
      const local = makeWorktree({
        id: 'wt',
        repoId: 'repo',
        projectId: 'local-project',
        hostId: 'local',
        path
      })
      const remote = {
        ...local,
        hostId: 'runtime:windows',
        path: 'C:/remote',
        projectId: 'remote-project'
      }
      const repos = [
        { id: 'repo', executionHostId: 'local' },
        { id: 'repo', executionHostId: 'runtime:windows' }
      ]
      const projects = [
        {
          id: 'local-project',
          sourceRepoIds: ['repo'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        },
        {
          id: 'remote-project',
          sourceRepoIds: ['repo'],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        }
      ]
      const state = makeState({
        settings,
        projects: reverse ? projects.toReversed() : projects,
        repos: reverse ? repos.toReversed() : repos,
        activeWorktreeId: 'wt',
        activeWorkspaceExecutionHostId: 'local',
        worktreesByRepo: { repo: reverse ? [remote, local] : [local, remote] }
      })
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      const selectedProjects = state.projects
      state.projects = state.projects.filter((project) => project.id !== 'local-project')
      // The absent explicit project falls back to its UNC path, never the rival repo match.
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      state.projects = selectedProjects.map((project) =>
        project.id === 'local-project'
          ? { ...project, localWindowsRuntimePreference: { kind: 'windows-host' } }
          : project
      )
      expect(selectNativeChatWslProject(state, 'wt')).toBe(false)
      state.projects = selectedProjects
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      expect(
        selectNativeChatWslProject({ ...state, activeWorkspaceExecutionHostId: null }, 'wt')
      ).toBeNull()
    }
  )
})
