import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { getOrphanTerminalIds } from './terminal-orphan-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import {
  MIXED_FOLDER,
  MIXED_GROUP
} from '../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import { resolveWorktreeOperationRouteForHost } from '@/lib/worktree-operation-route'
import { resolveTerminalPaneOwnerContext } from '@/components/terminal-pane/terminal-pane-owner-context'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

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

describe('createTab beside a lone pane', () => {
  const wt = 'repo1::/path/wt1'

  function seededStore() {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })
    return store
  }

  function groupIdOf(
    store: ReturnType<typeof createTestStore>,
    terminalId: string
  ): string | undefined {
    return (store.getState().unifiedTabsByWorktree[wt] ?? []).find(
      (tab) => tab.entityId === terminalId || tab.id === terminalId
    )?.groupId
  }

  it('leaves the first terminal as the only pane', () => {
    const store = seededStore()
    const only = store.getState().createTab(wt)

    const s = store.getState()
    expect(s.groupsByWorktree[wt]).toHaveLength(1)
    expect(s.layoutByWorktree[wt]).toEqual({ type: 'leaf', groupId: groupIdOf(store, only.id) })
  })

  it('opens the second terminal in a new right-hand group and focuses it', () => {
    const store = seededStore()
    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt)

    const s = store.getState()
    const firstGroupId = groupIdOf(store, first.id)
    const secondGroupId = groupIdOf(store, second.id)
    expect(firstGroupId).toBeDefined()
    expect(secondGroupId).toBeDefined()
    expect(secondGroupId).not.toBe(firstGroupId)
    expect(s.layoutByWorktree[wt]).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', groupId: firstGroupId },
      second: { type: 'leaf', groupId: secondGroupId }
    })
    expect(s.activeGroupIdByWorktree[wt]).toBe(secondGroupId)
    // Why: the runtime tab and its unified tab publish together — no empty right group survives.
    expect(s.groupsByWorktree[wt]?.find((g) => g.id === secondGroupId)?.tabOrder).toEqual([
      second.id
    ])
  })

  it('never opens a third pane: the third terminal opens opposite the focused pane', () => {
    const store = seededStore()
    const first = store.getState().createTab(wt)
    store.getState().createTab(wt)
    const third = store.getState().createTab(wt)

    const s = store.getState()
    // Why: both sides show a terminal, so it opens opposite the focused (second) pane.
    expect(groupIdOf(store, third.id)).toBe(groupIdOf(store, first.id))
    expect(s.groupsByWorktree[wt]).toHaveLength(2)
    expect(s.layoutByWorktree[wt]?.type).toBe('split')
  })

  it('opens beside without stealing focus when activate is false', () => {
    const store = seededStore()
    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt, undefined, undefined, { activate: false })

    const s = store.getState()
    const firstGroupId = groupIdOf(store, first.id)
    expect(groupIdOf(store, second.id)).not.toBe(firstGroupId)
    expect(s.activeGroupIdByWorktree[wt]).toBe(firstGroupId)
    expect(s.layoutByWorktree[wt]?.type).toBe('split')
  })

  it('opens a terminal beside a lone editor pane', () => {
    const store = seededStore()
    const editor = store.getState().createUnifiedTab(wt, 'editor', { entityId: '/a.ts' })
    const terminal = store.getState().createTab(wt)

    expect(groupIdOf(store, terminal.id)).not.toBe(editor.groupId)
    expect(store.getState().layoutByWorktree[wt]?.type).toBe('split')
  })

  it('honours placementFixed so a reopen replays into its recorded group', () => {
    const store = seededStore()
    const first = store.getState().createTab(wt)
    const second = store.getState().createTab(wt, groupIdOf(store, first.id), undefined, {
      placementFixed: true
    })

    expect(groupIdOf(store, second.id)).toBe(groupIdOf(store, first.id))
    expect(store.getState().groupsByWorktree[wt]).toHaveLength(1)
  })

  it('leaves the floating terminal panel unsplit', () => {
    const store = seededStore()
    store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)
    store.getState().createTab(FLOATING_TERMINAL_WORKTREE_ID)

    const s = store.getState()
    expect(s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)
    expect(s.layoutByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.type).toBe('leaf')
  })

  it('does not record pane-split discovery for an automatic terminal split', () => {
    const store = seededStore()
    const recordSpy = vi.spyOn(store.getState(), 'recordFeatureInteraction')
    store.getState().createTab(wt)
    store.getState().createTab(wt)

    expect(recordSpy.mock.calls.map(([id]) => id)).not.toContain('terminal-panes')
  })

  it('opens a file clicked in a lone terminal as a right split, with no DOM in sight', () => {
    const store = seededStore()
    const terminal = store.getState().createTab(wt)
    store.getState().openFile(
      {
        filePath: '/tmp/a.ts',
        relativePath: 'a.ts',
        worktreeId: wt,
        language: 'typescript',
        mode: 'edit'
      },
      { forceContentReload: true }
    )

    const s = store.getState()
    const editorTab = (s.unifiedTabsByWorktree[wt] ?? []).find(
      (tab) => tab.contentType === 'editor'
    )
    expect(editorTab?.groupId).toBeTruthy()
    expect(editorTab?.groupId).not.toBe(groupIdOf(store, terminal.id))
    expect(s.layoutByWorktree[wt]?.type).toBe('split')
  })
})
