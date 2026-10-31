import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'
import { toAgentLaunchPreferences } from '../../../shared/agent-launch-preferences'
import { resolveAgentSessionOptionLaunch } from '../../../shared/agent-session-option-launch'
import { terminalSessionOptionInputs } from '../../../shared/tui-agent-launch-command'

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

  // The own pane's chain, as main plans it: string wire, the agent's strict preferences, the host.
  it('keeps saved Cursor booleans to the terminal model, same-scope or yielding to own args', () => {
    const argv = (sessionOptions: Record<string, string | boolean>) => {
      const { tabId } = launchAgentThroughHost({
        agent: 'cursor',
        worktreeId: WT,
        prompt: 'p',
        sessionOptions
      })
      const preferences = toAgentLaunchPreferences(
        queuedLaunch(tabId)?.launch.sessionOptions,
        'cursor'
      )
      return resolveAgentSessionOptionLaunch('cursor', { ...preferences }, [], false).args.join(' ')
    }
    const thinking = { model: 'claude-opus-4-8', thinking: 'true', effort: 'high' }
    const yielded = terminalSessionOptionInputs({
      agent: 'cursor',
      sessionOptions: thinking,
      yieldToAgentArgs: true,
      agentArgs: '--force',
      shell: 'posix'
    }).sessionOptions!
    expect(argv(thinking)).toBe('--model claude-opus-4-8-thinking-high')
    expect(argv(yielded)).toBe('--model claude-opus-4-8-thinking-high')
    expect(argv({ ...thinking, thinking: false })).toBe('--model claude-opus-4-8-high')
    expect(argv({ model: 'gpt-5.3-codex', fastMode: true })).toBe('--model gpt-5.3-codex-fast')
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
