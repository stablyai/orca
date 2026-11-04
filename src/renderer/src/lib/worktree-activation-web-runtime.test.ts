import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../shared/setup-agent-sequencing'
import { activateAndRevealWorktree } from './worktree-activation'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import type { AppStoreState } from './worktree-activation.test-fixture'
import {
  createMockStore,
  registerWorktreeActivationReset
} from './worktree-activation.test-fixture'
import { useAppStore } from '@/store'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import {
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import '../runtime/runtime-environment-bridge-fixture'
import '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

import { createAutomationRunWorkspaceAction } from '../components/automations/automation-run-workspace-action'
import { resolveAutomationRunTarget } from '../components/automations/automation-run-open-target'
import { makeRun } from '../components/automations/automations-page-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../components/sidebar/folder-workspace-composer-submit-fixtures'
import { makePaneKey } from '../../../shared/stable-pane-id'

registerWorktreeActivationReset()
const originalCreateTab = useAppStore.getState().createTab
const originalSetActiveWorktree = useAppStore.getState().setActiveWorktree

afterEach(() => {
  useAppStore.setState({
    createTab: originalCreateTab,
    setActiveWorktree: originalSetActiveWorktree
  })
  vi.unstubAllGlobals()
  resetWebRuntimeWakeTerminalRespawnForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
})

describe('activateAndRevealWorktree', () => {
  it.each(['local', 'ssh:box', 'inherited-ssh'] as const)(
    'real historical folder action selects exact %s pane through the store without a replacement shell',
    (kind) => {
      const before = useAppStore.getState()
      const hostId = kind === 'local' ? 'local' : 'ssh:box'
      const folder = makeFolderWorkspace({
        id: 'historical-folder',
        projectGroupId: 'historical-group',
        ...(kind === 'inherited-ssh' ? {} : { executionHostId: hostId })
      })
      const workspaceId = folderWorkspaceKey(folder.id)
      const worktree = makeCreatedAgentWorktree()
      seedEmptyActivatableWorktree(worktree)
      const tabId = 'historical-folder-tab'
      const leafId = '11111111-1111-4111-8111-111111111111'
      const ptyId = 'historical-folder-pty'
      const createTab = vi.fn()
      const run = makeRun({
        workspaceId,
        terminalPaneKey: makePaneKey(tabId, leafId),
        terminalPtyId: ptyId
      })
      useAppStore.setState({
        setActiveWorktree: originalSetActiveWorktree,
        folderWorkspaces: [folder],
        projectGroups: [{ ...makeProjectGroup(), id: 'historical-group', executionHostId: hostId }],
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local',
        createTab,
        everActivatedWorktreeIds: new Set([workspaceId]),
        unifiedTabsByWorktree: {
          [workspaceId]: [
            {
              id: tabId,
              entityId: tabId,
              groupId: 'historical-group',
              worktreeId: workspaceId,
              contentType: 'terminal',
              executionHostId: hostId,
              label: 'Saved agent',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        tabsByWorktree: {
          [workspaceId]: [
            {
              id: tabId,
              worktreeId: workspaceId,
              ptyId,
              title: 'Saved agent',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { [tabId]: [ptyId] },
        terminalLayoutsByTabId: {
          [tabId]: {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: ptyId }
          }
        }
      })
      try {
        const runTargetFor = () =>
          resolveAutomationRunTarget(useAppStore.getState(), run, { kind: 'desktop' })
        expect(runTargetFor().worktree?.hostId).toBe(hostId)
        expect(runTargetFor().terminalTarget?.tabId).toBe(tabId)
        // SAFETY: this action uses only the list's historical target function.
        const open = createAutomationRunWorkspaceAction({
          list: { runTargetFor }
        })
        open(run)
        const after = useAppStore.getState()
        expect(after.activeWorktreeId).toBe(workspaceId)
        expect(after.activeWorkspaceExecutionHostId).toBe(hostId)
        expect(after.activeTabId).toBe(tabId)
        expect(after.terminalLayoutsByTabId[tabId].activeLeafId).toBe(leafId)
        expect(after.ptyIdsByTabId[tabId]).toEqual([ptyId])
        expect(createTab).not.toHaveBeenCalled()
      } finally {
        useAppStore.setState(before, true)
      }
    }
  )

  it('real historical workspace-only inherited folder enters through the fresh native folder path', () => {
    const before = useAppStore.getState()
    const folder = makeFolderWorkspace({
      id: 'fresh-history-folder',
      projectGroupId: 'fresh-history-group'
    })
    const workspaceId = folderWorkspaceKey(folder.id)
    seedEmptyActivatableWorktree(makeCreatedAgentWorktree())
    const run = makeRun({ workspaceId, terminalPaneKey: null, terminalPtyId: null })
    useAppStore.setState({
      folderWorkspaces: [folder],
      projectGroups: [
        { ...makeProjectGroup(), id: folder.projectGroupId, executionHostId: 'ssh:box' }
      ],
      unifiedTabsByWorktree: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      everActivatedWorktreeIds: new Set()
    })
    try {
      const runTargetFor = () =>
        resolveAutomationRunTarget(useAppStore.getState(), run, { kind: 'desktop' })
      expect(runTargetFor().viewState.canOpen).toBe(true)
      // SAFETY: only the historical resolver is consumed by this action.
      createAutomationRunWorkspaceAction({ list: { runTargetFor } })(run)
      expect(useAppStore.getState().activeWorktreeId).toBe(workspaceId)
      expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:box')
    } finally {
      useAppStore.setState(before, true)
    }
  })
  it('forwards sidebar seedStartupIfEmpty to the web-runtime wake helper on a live runtime host', async () => {
    const worktree = {
      ...makeCreatedAgentWorktree(),
      hostId: 'runtime:web-runtime-1' as const,
      runtimeOwnerEnvironmentId: 'web-runtime-1'
    }
    const seedStartupIfEmpty = {
      command: 'codex',
      launchAgent: 'codex' as const
    }
    const callRuntimeEnvironment = vi.fn(
      async (request: { method: string; params?: Record<string, unknown> }) =>
        request.method === 'session.tabs.createTerminal'
          ? {
              ok: true,
              result: {
                tab: { id: 'host-agent-tab', leafId: 'host-agent-leaf' },
                publicationEpoch: 'epoch-1',
                snapshotVersion: 1
              }
            }
          : { ok: false, error: { code: 'test', message: 'stop after recording the request' } }
    )
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: callRuntimeEnvironment } }
    })
    seedEmptyActivatableWorktree(worktree)
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: settings
        ? { ...settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof settings)
    })

    activateAndRevealWorktree(worktree.id, { seedStartupIfEmpty })

    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
    await vi.waitFor(() =>
      expect(callRuntimeEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'worktree.activate' })
      )
    )

    const createRequests = callRuntimeEnvironment.mock.calls.filter(
      ([request]) => request.method === 'session.tabs.createTerminal'
    )
    expect(createRequests).toHaveLength(1)
    expect(createRequests[0]?.[0]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          command: 'codex',
          launchAgent: 'codex'
        })
      })
    )
    await vi.waitFor(() => expect(shouldSkipWebRuntimeWakeTerminalRespawn(worktree.id)).toBe(false))
  })

})

describe('ensureWorktreeHasInitialTerminal', () => {
  it('holds the issue command for the first mirrored web runtime tab when none exists yet', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: 'web-runtime-1' }
        : ({ activeRuntimeEnvironmentId: 'web-runtime-1' } as unknown as typeof state.settings),
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-1',
            repoId: 'repo-1',
            hostId: 'local',
            runtimeOwnerEnvironmentId: 'web-runtime-1'
          }
        ] as never
      }
    }))
    useAppStore.setState({
      tabsByWorktree: {},
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(store, 'wt-1', undefined, undefined, {
      command: 'gh issue view 42'
    })

    // Why: runtime session tabs mirror in asynchronously — the command must be
    // held for the first mirrored tab rather than silently dropped.
    expect(result).toBeNull()
    expect(useAppStore.getState().pendingIssueCommandSplitByTabId).toEqual({})

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })

  it('does not create a fallback while a backend startup terminal awaits mirroring', () => {
    useAppStore.setState({
      getKnownWorktreeById: ((id: string) =>
        id === 'wt-1'
          ? { id: 'wt-1' }
          : undefined) as unknown as AppStoreState['getKnownWorktreeById']
    } as Partial<AppStoreState>)
    const store = createMockStore()

    const result = ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      undefined,
      { command: 'gh issue view 42' },
      undefined,
      { backendStartupTerminalSpawned: true }
    )

    expect(result).toBeNull()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(store.setActiveTab).not.toHaveBeenCalled()

    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [{ id: 'mirror-tab-1' }] }
    } as unknown as Partial<AppStoreState>)

    expect(useAppStore.getState().pendingIssueCommandSplitByTabId['mirror-tab-1']).toEqual({
      command: 'gh issue view 42'
    })
  })
})
