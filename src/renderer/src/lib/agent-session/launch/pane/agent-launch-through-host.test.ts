import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTabsSliceMockApi } from '../../../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../../../store/testing/app-store-test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
createTabsSliceMockApi()

const { launchAgentThroughHost } = await import('./agent-launch-through-host')
const { settleAgentLaunchPaneStart } = await import('./agent-launch-pane-start')
const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
let store: ReturnType<typeof createTestStore>

function launchTab(tabId: string) {
  return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)
}

function queuedLaunch(tabId: string) {
  return store.getState().pendingStartupByTabId[tabId]?.agentLaunch
}

function launch(groupId = store.getState().activeGroupIdByWorktree[WT]) {
  return launchAgentThroughHost({
    agent: 'claude',
    worktreeId: WT,
    groupId,
    prompt: 'fix the failing checks',
    agentArgs: null,
    launchSource: 'source_control_recovery'
  })
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  store.getState().setActiveWorktree(WT)
  store.getState().createUnifiedTab(WT, 'terminal')
})

describe('a desktop AI-button launch', () => {
  it('shows its tab at the click, in its split, with the launch queued for its pane to start', () => {
    const activeGroupId = store.getState().activeGroupIdByWorktree[WT]
    const targetGroupId = store
      .getState()
      .createEmptySplitGroup(WT, activeGroupId, 'down', { activate: false })!
    const { tabId } = launch(targetGroupId)
    expect(
      store.getState().groupsByWorktree[WT].find((group) => group.id === targetGroupId)?.tabOrder
    ).toContain(tabId)

    const tab = launchTab(tabId)!
    expect(tab).toMatchObject({ ptyId: null, launchAgent: 'claude' })
    expect(tab.agentLaunchPane?.leafId).toBeTruthy()
    expect(agentLaunchPanePrompt(tab.id)).toBe('fix the failing checks')
    expect(store.getState().activeTabId).toBe(tabId)
    // No prompt: the window pastes it, as main does, once the agent runs.
    expect(queuedLaunch(tabId)).toEqual({
      launch: {
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${WT}` },
        agentArgs: null,
        launchSource: 'source_control_recovery'
      }
    })
  })

  it("says the agent started once its pane's spawn returns, and not when main says it failed", async () => {
    const started = launch()
    const leafId = launchTab(started.tabId)!.agentLaunchPane!.leafId
    settleAgentLaunchPaneStart(started.tabId, leafId, 'pty-1')
    await expect(started.started).resolves.toBe('pty-1')

    const failed = launch()
    const failedLeaf = launchTab(failed.tabId)!.agentLaunchPane!.leafId
    applyAgentLaunchPaneVerdict({
      worktreeId: WT,
      tabId: failed.tabId,
      leafId: failedLeaf,
      verdict: { kind: 'not-started', code: 'spawn claude ENOENT' }
    })
    settleAgentLaunchPaneStart(failed.tabId, failedLeaf, 'pty-2')
    await expect(failed.started).resolves.toBeNull()
  })

  it('keeps inactive launches in their requested group without revealing Terminal', () => {
    const initial = store.getState()
    const activeTabId = initial.activeTabId
    const groupId = initial.createEmptySplitGroup(WT, initial.activeGroupIdByWorktree[WT], 'down', {
      activate: false
    })!
    const { tabId } = launchAgentThroughHost({
      agent: 'claude',
      worktreeId: WT,
      groupId,
      prompt: 'p',
      cwd: '/tmp/feature/sub',
      activate: false
    })
    expect(store.getState().activeTabId).toBe(activeTabId)
    expect(
      store.getState().groupsByWorktree[WT].find((group) => group.id === groupId)?.tabOrder
    ).toContain(tabId)
    expect(queuedLaunch(tabId)?.launch.cwd).toBe('/tmp/feature/sub')
  })
})

it.each([null, 'ssh-1'])(
  'queues an edited empty-prompt launch through destination %s with pane identity retained',
  async (connectionId) => {
    const { launchNewTabThroughHost } = await import('../new-tab/launch-agent-new-tab-host-route')
    const { planQueuedPaneAgentLaunch } =
      await import('../../../../../../main/ipc/pty/pane-agent-launch.test-fixture')
    const { tokenizeStartupCommand } =
      await import('../../../../../../shared/agent-launch/startup/tui-agent-startup-shell')
    const { tabId } = launchNewTabThroughHost({
      agent: 'antigravity',
      worktreeId: WT,
      prompt: '',
      terminalOptionEdits: { effort: null },
      activate: false,
      cwd: '/synthetic/project/sub'
    })
    const pending = queuedLaunch(tabId)
    expect(pending).toEqual({
      launch: {
        agent: 'antigravity',
        target: { kind: 'existing', worktree: `id:${WT}` },
        terminalOptionEdits: { effort: null },
        cwd: '/synthetic/project/sub'
      }
    })
    const planned = await planQueuedPaneAgentLaunch(
      pending,
      {
        agentCmdOverrides: { antigravity: 'agy' },
        agentPermissionDefault: 'full-access',
        agentDefaultArgs: { antigravity: '--effort=high --add-dir current' },
        agentLaunchChoices: { antigravity: { options: { effort: 'low' } } }
      },
      { worktreeId: WT, tabId, leafId: launchTab(tabId)!.agentLaunchPane!.leafId },
      { connectionId, ...(connectionId ? { startupCommandDelivery: 'shell-ready' as const } : {}) }
    )
    expect(tokenizeStartupCommand(planned.command ?? '', 'posix')).toEqual({
      ok: true,
      tokens: ['agy', '--dangerously-skip-permissions', '--add-dir', 'current']
    })
    expect(planned.tabId).toBe(tabId)
    expect(planned.cwd).toBe('/synthetic/project/sub')
    expect(planned.connectionId).toBe(connectionId)
    if (connectionId) {
      expect(planned.startupCommandDelivery).toBe('shell-ready')
    }
  }
)
