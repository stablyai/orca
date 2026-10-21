import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
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

function launch() {
  return launchAgentThroughHost({
    agent: 'claude',
    worktreeId: WT,
    groupId: store.getState().activeGroupIdByWorktree[WT],
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
    const { tabId } = launch()

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

  // Nothing reads a click's launch record, so its launch carries no operation and writes none.
  it('names no operation, and each click has its own pane', () => {
    const first = launch().tabId
    const second = launch().tabId
    expect(queuedLaunch(first)?.launch).not.toHaveProperty('operationId')
    expect(second).not.toBe(first)
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
})
