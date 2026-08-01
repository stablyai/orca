import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  setActiveTabType: vi.fn()
}))

const store = {
  tabsByWorktree: {} as Record<string, { id: string; launchAgent?: string }[]>,
  pendingStartupByTabId: {} as Record<string, { command: string }>,
  automaticAgentResumeClaimsByTabId: {} as Record<string, unknown>,
  closeTab: mocks.closeTab,
  setActiveTabType: mocks.setActiveTabType
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal,
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn(),
  isWebTerminalSurfaceTabId: (id: string) => id.startsWith('web-surface:')
}))

import { launchAgentInWebHostTab } from './launch-agent-web-host-tab'
import {
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from '@/runtime/web-agent-session-handoff'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'

const startupPlan: AgentStartupPlan = {
  agent: 'claude',
  launchCommand: 'claude',
  expectedProcess: 'claude',
  followupPrompt: null,
  launchConfig: { agentArgs: '', agentEnv: {} }
}

function launch(): Promise<{ delivered: boolean; failureNotified: boolean }> {
  return launchAgentInWebHostTab({
    agent: 'claude',
    worktreeId: 'wt-1',
    environmentId: 'env-1',
    startupPlan,
    prompt: '',
    promptDelivery: 'auto-submit',
    pastePromptAfterReady: null,
    submitPastedPrompt: false
  })
}

describe('launchAgentInWebHostTab stale-tab prune', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWebAgentSessionHandoffsForTests()
    store.tabsByWorktree = { 'wt-1': [] }
    store.pendingStartupByTabId = {}
    store.automaticAgentResumeClaimsByTabId = {}
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    // Why: mirror the real store — a closed tab leaves tabsByWorktree, so the
    // post-create pass sees the pruned state, not the pre-create one.
    mocks.closeTab.mockImplementation((tabId: string) => {
      for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree)) {
        store.tabsByWorktree[worktreeId] = tabs.filter((tab) => tab.id !== tabId)
      }
    })
  })

  it('keeps a provisional tab with a recorded handoff through pre- and post-create prunes', async () => {
    store.tabsByWorktree['wt-1'] = [{ id: 'prov-1', launchAgent: 'claude' }]
    recordWebAgentSessionHandoff({
      environmentId: 'env-1',
      worktreeId: 'wt-1',
      provisionalTabId: 'prov-1',
      hostTabId: 'host-1',
      hostTerminalHandle: 'term-1'
    })

    await launch()

    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(store.tabsByWorktree['wt-1']).toEqual([{ id: 'prov-1', launchAgent: 'claude' }])
  })

  it('keeps tabs with a queued startup command or an automatic resume claim', async () => {
    store.tabsByWorktree['wt-1'] = [
      { id: 'pending-1', launchAgent: 'claude' },
      { id: 'claimed-1', launchAgent: 'claude' }
    ]
    store.pendingStartupByTabId['pending-1'] = { command: 'claude' }
    store.automaticAgentResumeClaimsByTabId['claimed-1'] = { worktreeId: 'wt-1' }

    await launch()

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('prunes a genuinely stale tab without firing a host terminal.close', async () => {
    store.tabsByWorktree['wt-1'] = [
      { id: 'stale-1', launchAgent: 'claude' },
      { id: 'plain-terminal' },
      { id: 'web-surface:1', launchAgent: 'claude' }
    ]

    await launch()

    expect(mocks.closeTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeTab).toHaveBeenCalledWith('stale-1', {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true
    })
    expect(store.tabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual([
      'plain-terminal',
      'web-surface:1'
    ])
  })

  it('post-create prune ignores tabs created mid-operation', async () => {
    store.tabsByWorktree['wt-1'] = [{ id: 'stale-1', launchAgent: 'claude' }]
    mocks.createWebRuntimeSessionTerminal.mockImplementation(async () => {
      store.tabsByWorktree['wt-1'] = [
        ...store.tabsByWorktree['wt-1'],
        { id: 'mid-op-tab', launchAgent: 'claude' }
      ]
      return { status: 'created' }
    })

    await launch()

    expect(mocks.closeTab).toHaveBeenCalledTimes(1)
    expect(mocks.closeTab).toHaveBeenCalledWith('stale-1', {
      reason: 'cleanup',
      remoteCloseOwnedByHost: true
    })
    expect(store.tabsByWorktree['wt-1'].map((tab) => tab.id)).toEqual(['mid-op-tab'])
  })
})
