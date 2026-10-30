import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { AgentTabLaunchOutcome } from '@/lib/launch-agent-in-new-tab-host-agents'

const mocks = vi.hoisted(() => ({
  launch:
    vi.fn<(args: LaunchAgentInNewTabArgs, notifyFailure?: boolean) => AgentTabLaunchOutcome>(),
  closeTab: vi.fn<(tabId: string) => void>(),
  state: {
    // Only the slices the real tab close consults before applying its landing patch.
    activeWorktreeId: 'wt-1' as string | null,
    tabsByWorktree: {} as Record<
      string,
      { id: string; customTitle: string | null; launchAgent?: string }[]
    >,
    pendingStartupByTabId: {} as Record<string, unknown>,
    pendingIssueCommandSplitByTabId: {} as Record<string, unknown>,
    removePendingWorktreeCreation: vi.fn(),
    updateWorktreeMeta: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ ...mocks.state, closeTab: mocks.closeTab })
  }
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launch
}))
vi.mock('@/lib/new-workspace', () => ({ ensureAgentStartupInTerminal: vi.fn() }))
vi.mock('@/lib/worktree-creation-agent-seeds', () => ({
  seedAgentTabStateAfterWorktreeCreate: vi.fn()
}))
vi.mock('@/lib/workspace-activation-terminal-focus', () => ({
  queueWorkspaceActivationTerminalFocus: vi.fn()
}))

import { completeWorktreeCreation } from './worktree-creation-completion'

function creationRequest(
  overrides: Partial<WorktreeCreationRequest> = {}
): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name: 'fix',
    setupDecision: 'skip',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: 'Fix the flaky test',
    quickTelemetry: null,
    agentLaunches: [{ agent: 'codex' }, { agent: 'claude' }],
    ...overrides
  }
}

function completionArgs(
  overrides: Partial<Parameters<typeof completeWorktreeCreation>[0]> = {}
): Parameters<typeof completeWorktreeCreation>[0] {
  return {
    creationId: 'creation-1',
    request: creationRequest(),
    worktreeId: 'wt-1',
    structuredLaunchAccepted: false,
    activation: false,
    primaryTabId: 'blank-tab',
    backendSpawned: false,
    hostPlannedStartup: false,
    focusOnCompletion: false,
    ...overrides
  }
}

beforeEach(() => {
  mocks.launch.mockReset()
  mocks.closeTab.mockReset()
  mocks.state.activeWorktreeId = 'wt-1'
  mocks.state.tabsByWorktree = { 'wt-1': [{ id: 'blank-tab', customTitle: null }] }
  mocks.state.pendingStartupByTabId = {}
  mocks.state.pendingIssueCommandSplitByTabId = {}
  mocks.state.removePendingWorktreeCreation.mockReset()
  mocks.state.updateWorktreeMeta.mockReset()
  mocks.launch.mockImplementation((args) => {
    const tabs = (mocks.state.tabsByWorktree[args.worktreeId] ??= [])
    const tabId = `agent-tab-${tabs.filter((tab) => tab.launchAgent).length + 1}`
    tabs.push({ id: tabId, customTitle: null, launchAgent: args.agent })
    return { surface: { kind: 'local-terminal', tabId }, pasteDraftAfterLaunch: false }
  })
  // Mirrors the real close: removing the worktree's last tab applies the landing patch.
  mocks.closeTab.mockImplementation((tabId: string) => {
    const tabs = (mocks.state.tabsByWorktree['wt-1'] ?? []).filter((tab) => tab.id !== tabId)
    mocks.state.tabsByWorktree['wt-1'] = tabs
    if (tabs.length === 0) {
      mocks.state.activeWorktreeId = null
    }
  })
})

describe('completeWorktreeCreation multi-agent handoff', () => {
  it('keeps the created worktree active when the lone seeded blank tab is absorbed', async () => {
    await completeWorktreeCreation(completionArgs())

    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.closeTab).toHaveBeenCalledWith('blank-tab', { captureRecentlyClosed: false })
    expect(mocks.state.tabsByWorktree['wt-1'].map((tab) => tab.launchAgent)).toEqual([
      'codex',
      'claude'
    ])
    // Neither launch nor the blank-tab close may drop the user back to the landing view.
    expect(mocks.state.activeWorktreeId).toBe('wt-1')
    expect(mocks.state.removePendingWorktreeCreation).toHaveBeenCalledWith('creation-1', {
      cleanupVm: false
    })
  })

  it('keeps the legacy seeding path when the request carries no launch list', async () => {
    await completeWorktreeCreation(
      completionArgs({ request: creationRequest({ agentLaunches: undefined, agent: 'codex' }) })
    )

    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
    expect(mocks.state.tabsByWorktree['wt-1']).toHaveLength(1)
  })
})
