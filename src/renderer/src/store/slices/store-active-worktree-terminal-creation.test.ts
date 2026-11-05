import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import {
  MIXED_FOLDER,
  MIXED_GROUP
} from '../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'
import { resolveTerminalPaneOwnerContext } from '@/components/terminal-pane/terminal-pane-owner-context'

const remoteCreate = vi.hoisted(() => vi.fn(async () => ({ status: 'created' })))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: remoteCreate
}))

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it.each([false, true])(
    'retains a selected folder through normal tab creation (%s)',
    (reverse) => {
      const originalNavigator = globalThis.navigator
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        configurable: true
      })
      try {
        const store = createTestStore()
        const localFolder = {
          ...MIXED_FOLDER,
          folderPath: 'C:/work/notes',
          executionHostId: 'local' as const
        }
        const remoteFolder = { ...localFolder, executionHostId: 'ssh:prod' as const }
        const localRepo = {
          id: 'repo1',
          path: 'C:/work/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          projectGroupId: MIXED_GROUP.id,
          executionHostId: 'local' as const
        }
        const remoteRepo = { ...localRepo, executionHostId: 'ssh:prod' as const }
        const worktreeId = `folder:${localFolder.id}`
        seedStore(store, {
          activeWorktreeId: worktreeId,
          activeWorkspaceExecutionHostId: 'local',
          repos: reverse ? [remoteRepo, localRepo] : [localRepo, remoteRepo],
          folderWorkspaces: reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
          projectGroups: [MIXED_GROUP],
          projectHostSetups: [localRepo, remoteRepo].map((repo) => ({
            id: `setup-${repo.executionHostId}`,
            projectId: 'project',
            repoId: repo.id,
            hostId: repo.executionHostId,
            path: repo.path,
            displayName: repo.displayName,
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 0,
            updatedAt: 0
          })),
          projects: [
            {
              id: 'project',
              displayName: 'Project',
              badgeColor: '#000',
              sourceRepoIds: ['repo1'],
              localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
              createdAt: 0,
              updatedAt: 0
            }
          ],
          settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' }
        })
        const terminal = store.getState().createTab(worktreeId)
        const current = store.getState()
        const owner = resolveTerminalPaneOwnerContext(
          current,
          worktreeId,
          terminal.id,
          resolveWorktreeOperationRouteForHost(current, worktreeId, 'local')
        )
        expect({
          shell: terminal.shellOverride,
          stamp: current.unifiedTabsByWorktree[worktreeId][0].executionHostId,
          path: owner.worktree?.path,
          runtimeRepo: owner.projectRuntimeTarget?.repo
        }).toEqual({
          shell: 'wsl.exe',
          stamp: 'local',
          path: localFolder.folderPath,
          runtimeRepo: localRepo
        })
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true
        })
      }
    }
  )

  // Promote a surviving split pane into the relay slot on exit; otherwise relay-drop clearing can make orphan sweep delete the live tab (#9911).
  it('promotes a surviving pane into the relay slot so a split tab is not orphaned after a relay drop', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const tabId = 'tab-split'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: tabId, worktreeId: wt, ptyId: 'pty-B' })] },
      ptyIdsByTabId: { [tabId]: ['pty-A', 'pty-B'] },
      // Newest-bound pane B owns the single relay slot.
      lastKnownRelayPtyIdByTabId: { [tabId]: 'pty-B' },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          activeLeafId: 'leaf-a',
          expandedLeafId: null,
          ptyIdsByLeafId: { 'leaf-a': 'pty-A', 'leaf-b': 'pty-B' }
        }
      },
      // The transiently-absent unified entry is the condition #9911 recovers from.
      unifiedTabsByWorktree: { [wt]: [] }
    })

    // Pane B (the relay-slot owner) exits: the slot must fall back to survivor A.
    store.getState().clearTabPtyId(tabId, 'pty-B')
    expect(store.getState().ptyIdsByTabId[tabId]).toEqual(['pty-A'])
    expect(store.getState().lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')

    // Relay drop bulk-clears the row + live index but preserves the relay slot.
    store.getState().clearTabPtyId(tabId)
    const state = store.getState()
    expect(state.ptyIdsByTabId[tabId]).toEqual([])
    expect(state.tabsByWorktree[wt][0].ptyId).toBeNull()
    expect(state.lastKnownRelayPtyIdByTabId[tabId]).toBe('pty-A')
    expect(getOrphanTerminalIds(state, wt)).not.toContain(tabId)
  })
})

describe('explicit workspace terminal creation', () => {
  it.each([true, false])(
    'uses an explicit menu owner or the active shortcut workspace (%s)',
    async (explicit) => {
      const store = createTestStore()
      const first = makeWorktree({ id: 'repo1::/path/a', repoId: 'repo1', path: '/path/a' })
      const second = makeWorktree({ id: 'repo1::/path/b', repoId: 'repo1', path: '/path/b' })
      seedStore(store, {
        worktreesByRepo: { repo1: [first, second] },
        activeWorktreeId: second.id,
        activeWorkspaceExecutionHostId: 'local'
      })
      await store
        .getState()
        .openNewTerminalTabInActiveWorkspace('menu-group', explicit ? first.id : undefined)
      const target = explicit ? first.id : second.id
      const other = explicit ? second.id : first.id
      expect(store.getState().tabsByWorktree[target]).toHaveLength(1)
      expect(store.getState().tabsByWorktree[other] ?? []).toEqual([])
    }
  )
})

it('routes a captured host despite a same-id workspace on another host', async () => {
  const store = createTestStore()
  const id = 'repo1::/path/twin'
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', path: '/path/twin', hostId: 'local' }),
        makeWorktree({
          id,
          repoId: 'repo1',
          path: '/path/twin',
          hostId: 'runtime:peer',
          runtimeOwnerEnvironmentId: 'peer'
        })
      ]
    },
    activeWorktreeId: 'another-workspace',
    activeWorkspaceExecutionHostId: 'local'
  })
  await store.getState().openNewTerminalTabInActiveWorkspace('menu-group', id, 'runtime:peer')
  expect(remoteCreate).toHaveBeenCalledWith(
    { worktreeId: id, environmentId: 'peer', targetGroupId: 'menu-group', activate: true },
    { userAct: true }
  )
  expect(store.getState().tabsByWorktree[id] ?? []).toEqual([])
  await store.getState().openNewTerminalTabInActiveWorkspace('menu-group', id, 'local')
  expect(store.getState().unifiedTabsByWorktree[id]?.[0]?.executionHostId).toBe('local')
})
