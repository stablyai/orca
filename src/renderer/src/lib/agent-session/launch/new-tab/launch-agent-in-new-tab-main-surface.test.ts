import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planQueuedPaneAgentLaunch } from '../../../../../../main/ipc/pty/pane-agent-launch.test-fixture'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultSettings
} from '../../../../../../shared/constants'
import { createTestStore, seedStore } from '../../../../store/slices/store-test-helpers'
import {
  makeWorktree,
  makeFolderWorkspace
} from '../../../../store/slices/worktrees-slice-test-fixtures'
import { resolveQueuedInitialCwd } from '@/components/terminal-pane/mounting/queued-initial-cwd'
import { settleAgentLaunchPaneStart } from '../pane/agent-launch-pane-start'
import { sourceControlActionRecipeEntry } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { createStoreCascadesMockApi } from '../../../../store/slices/store-cascades-test-harness'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store/index', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

vi.mock('@/lib/host-chat-program-acquisition', async (original) => ({
  ...(await original<object>()),
  acquireAgentLaunchChoices: async () => ({ detected: ['claude', 'codex'] })
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

vi.mock('@/lib/agent-session/launch/prompt/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: async () => ({ delivered: true, failureNotified: false })
}))

createStoreCascadesMockApi()

import { makeFolderWorkspace as makeLaunchFolderWorkspace } from '@/components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setLocalRuntimeCapabilitiesForTests([])
})

const MAIN_WORKTREE_ID = 'repo1::/path/wt1'

function seedMainWindowOnEditor(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: {
      repo1: [makeWorktree({ id: MAIN_WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: MAIN_WORKTREE_ID
  })
  const mainTerminal = store.getState().createTab(MAIN_WORKTREE_ID)
  store.getState().setActiveTabType('editor', MAIN_WORKTREE_ID)
  expect(store.getState().activeTabId).toBe(mainTerminal.id)
  return store
}

describe('launchAgentInNewTab main-window surface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reveals the captured folder owner before real tab creation when host facts arrive after a rival selection', async () => {
    const store = seedMainWindowOnEditor()
    const id = 'folder:captured'
    store.setState((state) => ({
      settings: {
        ...(state.settings ?? getDefaultSettings('/tmp')),
        nativeChatProviders: { claude: true }
      },
      folderWorkspaces: [
        makeLaunchFolderWorkspace({ id: 'captured', executionHostId: 'local' }),
        makeLaunchFolderWorkspace({ id: 'captured', executionHostId: 'runtime:rival' })
      ]
    }))
    store.getState().setActiveFolderWorkspace('captured', 'local')
    const shell = store.getState().createTab(id)
    const facts = Promise.withResolvers<void>()
    const getStatus = vi.fn(async () => {
      await facts.promise
      return { capabilities: [] }
    })
    vi.stubGlobal('window', {
      api: { ...window.api, runtime: { ...window.api.runtime, getStatus } }
    })
    setLocalRuntimeCapabilitiesForTests(null)
    const { launchAgentInNewTabWithOutcome } = await import('./launch-agent-in-new-tab')
    const { settleAgentTabLaunch } = await import('./launch-agent-in-new-tab-host-agents')
    const { activateAndRevealWorkspaceWithOutcome } =
      await import('@/lib/workspace/activation/worktree-activation')
    const { reportAgentWorkspaceActivation } = await import('@/lib/worktree-activation-outcome')
    const reveal = vi.fn(() =>
      reportAgentWorkspaceActivation(
        activateAndRevealWorkspaceWithOutcome(id, {
          agent: 'claude',
          providesInitialSurface: true,
          executionHostId: 'local'
        }),
        'claude'
      )
    )
    const result = launchAgentInNewTabWithOutcome({
      requestId: 'captured-folder-facts',
      agent: 'claude',
      worktreeId: id,
      workspaceExecutionHostId: 'local',
      beforeSurfaceOpen: reveal,
      launchSource: 'onboarding'
    })
    expect(getStatus).toHaveBeenCalledOnce()
    expect(reveal).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree[id]).toHaveLength(1)
    store.getState().setActiveFolderWorkspace('captured', 'runtime:rival')
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('runtime:rival')
    facts.resolve()
    await expect(settleAgentTabLaunch(result)).resolves.toEqual({ kind: 'terminal' })
    const state = store.getState()
    expect(reveal).toHaveBeenCalledOnce()
    expect(state.activeWorkspaceExecutionHostId).toBe('local')
    expect(state.tabsByWorktree[id]).toHaveLength(2)
    const created = state.unifiedTabsByWorktree[id].find((tab) => tab.id !== shell.id)
    expect(created?.executionHostId).toBe('local')
    expect(state.tabsByWorktree[id].find((tab) => tab.id === created?.id)?.launchAgent).toBe(
      'claude'
    )
  })

  it('selects a floating launch in the floating panel without moving the main window', async () => {
    const store = seedMainWindowOnEditor()
    const before = store.getState()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'opencode',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    expect(result?.surface.kind).toBe('local-terminal')
    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : null
    const state = store.getState()
    expect(state.activeTabType).toBe('editor')
    expect(state.activeTabId).toBe(before.activeTabId)
    expect(state.activeTabTypeByWorktree[MAIN_WORKTREE_ID]).toBe('editor')
    // Select inside the floating group because its active tab controls the rendered pane.
    const floatingGroup = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]
    expect(floatingGroup?.activeTabId).toBe(tabId)
    expect(state.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(tabId)
    expect(state.activeTabTypeByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe('terminal')
  })
})

// A new tab can mount during its publication; its first spawn must already own the cwd.
it.each(
  (['claude', 'codex'] as const).flatMap((agent) =>
    (['resolveConflicts', 'fixCommitFailure'] as const).map((actionId) => ({ agent, actionId }))
  )
)(
  'starts section $actionId with $agent outside the folder on its first mount',
  async ({ agent, actionId }) => {
    const store = seedMainWindowOnEditor()
    const folder = makeFolderWorkspace({
      id: 'feature',
      folderPath: '/fixture/feat-x',
      executionHostId: 'local'
    })
    const childPath = '/Users/qa/orca/workspaces/app/s-fix'
    store.setState({
      folderWorkspaces: [folder],
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: MAIN_WORKTREE_ID, repoId: 'repo1', path: childPath, hostId: 'local' })
        ]
      }
    })
    store.getState().setActiveWorktree('folder:feature')
    const spawnCwds: string[] = []
    const starts: ReturnType<typeof store.getState>['pendingStartupByTabId'][string][] = []
    const mounted = new Set(
      (store.getState().tabsByWorktree['folder:feature'] ?? []).map((tab) => tab.id)
    )
    const unsubscribe = store.subscribe((state) => {
      for (const tab of state.tabsByWorktree['folder:feature'] ?? []) {
        if (mounted.has(tab.id) || tab.launchAgent !== agent) {
          continue
        }
        mounted.add(tab.id)
        starts.push(state.pendingStartupByTabId[tab.id])
        spawnCwds.push(
          resolveQueuedInitialCwd(
            undefined,
            () => state.consumeTabInitialCwd(tab.id),
            tab.startupCwd ?? folder.folderPath
          ).startupCwd
        )
        if (tab.agentLaunchPane) {
          settleAgentLaunchPaneStart(tab.id, tab.agentLaunchPane.leafId, 'section-pty')
        }
      }
    })
    try {
      const { runSourceControlAgentActionStart } =
        await import('@/components/right-sidebar/source-control/ai/runSourceControlAgentActionStart')
      const recipe = sourceControlActionRecipeEntry({ agentId: agent, surface: 'terminal' })
      const {
        launchSourceControlRecoveryAgentWithDefault,
        getDefaultSourceControlRecoveryLaunchCopy
      } = await import('@/components/right-sidebar/source-control/ai/recovery-launch')
      const launched =
        actionId === 'fixCommitFailure'
          ? await launchSourceControlRecoveryAgentWithDefault({
              activeWorktreeId: MAIN_WORKTREE_ID,
              placementWorkspaceId: 'folder:feature',
              initialCwd: childPath,
              activeGroupId: 'folder:feature',
              activeSourceControlLaunchPlatform: 'darwin',
              sourceRepoConnectionId: null,
              executionHostId: 'local',
              actionId,
              basePrompt: 'Fix the failed commit',
              getLaunchActionRecipe: () => recipe,
              getStoreState: store.getState,
              copy: getDefaultSourceControlRecoveryLaunchCopy('commit')
            })
          : await runSourceControlAgentActionStart({
              selectedAgent: agent,
              trimmedCommandInput: 'Resolve the conflicts',
              recipe,
              saveTargetValue: 'none',
              actionId: 'resolveConflicts',
              repoId: 'repo1',
              repo: store.getState().repos[0] ?? null,
              worktreeId: MAIN_WORKTREE_ID,
              placementWorkspaceId: 'folder:feature',
              initialCwd: childPath,
              groupId: 'folder:feature',
              promptDelivery: 'submit-after-ready',
              launchPlatform: 'darwin',
              launchSource: 'conflict_resolution',
              onClose: () => {}
            })
      expect(launched).toBe(true)
      expect(spawnCwds).toEqual(['/Users/qa/orca/workspaces/app/s-fix'])
      expect(starts).toHaveLength(1)
      expect(starts[0].trustWorktreeId).toBe(MAIN_WORKTREE_ID)
      const planned = await planQueuedPaneAgentLaunch(
        starts[0].agentLaunch,
        store.getState().settings ?? {},
        {
          worktreeId: 'folder:feature',
          tabId: 'section-tab',
          leafId: '11111111-1111-4111-8111-111111111111'
        },
        { trustWorktreeId: starts[0].trustWorktreeId, cwd: spawnCwds[0] }
      )
      expect(planned).toMatchObject({
        worktreeId: 'folder:feature',
        trustWorktreeId: MAIN_WORKTREE_ID,
        cwd: '/Users/qa/orca/workspaces/app/s-fix',
        launchAgent: agent
      })
    } finally {
      unsubscribe()
    }
  }
)
