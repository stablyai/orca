import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { AgentTabLaunchOutcome } from '@/lib/launch-agent-in-new-tab-host-agents'
import type { AgentLaunchListEntry, WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { runComposerAgentLaunchLoop } from './composer-agent-launch-loop'

const mocks = vi.hoisted(() => ({
  launch:
    vi.fn<(args: LaunchAgentInNewTabArgs, notifyFailure?: boolean) => AgentTabLaunchOutcome>(),
  closeTab: vi.fn(),
  state: {
    tabsByWorktree: {} as Record<
      string,
      {
        id: string
        launchAgent?: string
        customTitle: string | null
        quickCommandLabel?: string | null
        viewMode?: 'terminal' | 'chat'
      }[]
    >,
    pendingStartupByTabId: {} as Record<string, unknown>,
    pendingIssueCommandSplitByTabId: {} as Record<string, unknown>
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
    quickPrompt: '',
    quickTelemetry: null,
    agentLaunches: [{ agent: 'codex' }, { agent: 'claude' }],
    ...overrides
  }
}

function run(
  request: WorktreeCreationRequest,
  overrides: Partial<Parameters<typeof runComposerAgentLaunchLoop>[0]> = {}
) {
  return runComposerAgentLaunchLoop({
    worktreeId: 'wt-1',
    request,
    quickPrompt: 'Fix the flaky test',
    promptDelivery: 'auto-submit',
    linkedItemPrompt: null,
    ...overrides
  })
}

beforeEach(() => {
  mocks.launch.mockReset()
  mocks.closeTab.mockReset()
  mocks.state.tabsByWorktree = {}
  mocks.state.pendingStartupByTabId = {}
  mocks.state.pendingIssueCommandSplitByTabId = {}
  // A real launch publishes its tab synchronously; the loop reads that count before closing.
  mocks.launch.mockImplementation((args) => {
    const tabs = (mocks.state.tabsByWorktree[args.worktreeId] ??= [])
    const tabId = `agent-tab-${tabs.filter((tab) => tab.launchAgent).length + 1}`
    tabs.push({ id: tabId, customTitle: null, launchAgent: args.agent })
    return {
      surface: { kind: 'local-terminal', tabId },
      pasteDraftAfterLaunch: false
    }
  })
  mocks.closeTab.mockImplementation((tabId: string) => {
    for (const [worktreeId, tabs] of Object.entries(mocks.state.tabsByWorktree)) {
      mocks.state.tabsByWorktree[worktreeId] = tabs.filter((tab) => tab.id !== tabId)
    }
  })
})

describe('runComposerAgentLaunchLoop', () => {
  it('launches every entry in order with the composer handoff and per-entry inputs', () => {
    const launches: AgentLaunchListEntry[] = [
      {
        agent: 'codex',
        agentArgs: '--profile fast',
        requestedSurface: 'terminal',
        displayName: 'worker'
      },
      {
        agent: 'claude',
        sessionOptions: { model: 'opus' },
        requestedSurface: 'chat',
        displayName: 'reviewer'
      }
    ]

    expect(run(creationRequest({ agentLaunches: launches }))).toEqual({
      launched: 2,
      failed: 0
    })
    expect(mocks.launch).toHaveBeenCalledTimes(2)
    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-1',
      agentArgs: '--profile fast',
      requestedSurface: 'terminal',
      quickCommandLabel: 'worker',
      prompt: 'Fix the flaky test',
      promptDelivery: 'auto-submit',
      pendingActivationSpawn: true,
      activate: true,
      launchSource: 'new_workspace_composer'
    })
    expect(mocks.launch.mock.calls[1][0]).toMatchObject({
      agent: 'claude',
      sessionOptions: { model: 'opus' },
      requestedSurface: 'chat',
      quickCommandLabel: 'reviewer',
      pendingActivationSpawn: true,
      activate: false
    })
  })

  it('forces the terminal surface when the entry carries CLI flags', () => {
    run(
      creationRequest({
        agentLaunches: [{ agent: 'codex', agentArgs: '--profile fast', requestedSurface: 'chat' }]
      })
    )

    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ requestedSurface: 'terminal' })
  })

  it('prefers the linked-item prompt over the quick prompt', () => {
    run(creationRequest(), {
      quickPrompt: 'typed note',
      linkedItemPrompt: 'https://github.com/o/r/issues/12',
      promptDelivery: undefined
    })

    expect(mocks.launch.mock.calls[0][0]).toMatchObject({
      prompt: 'https://github.com/o/r/issues/12',
      promptDelivery: 'draft'
    })
  })

  it('absorbs the seeded blank terminal after the first agent tab exists', () => {
    mocks.state.tabsByWorktree['wt-1'] = [{ id: 'blank-tab', customTitle: null }]

    run(creationRequest())

    expect(mocks.closeTab).toHaveBeenCalledWith('blank-tab', { captureRecentlyClosed: false })
    // Closing the worktree's ONLY tab lands on the empty-workspace view, so the first launch
    // must publish its tab before the blank one goes away.
    const closeOrder = mocks.closeTab.mock.invocationCallOrder[0]
    expect(closeOrder).toBeGreaterThan(mocks.launch.mock.invocationCallOrder[0])
    expect(closeOrder).toBeLessThan(mocks.launch.mock.invocationCallOrder[1])
  })

  it('keeps a lone seeded blank terminal when the first launch fails', () => {
    mocks.launch.mockReturnValueOnce(null)
    mocks.state.tabsByWorktree['wt-1'] = [{ id: 'blank-tab', customTitle: null }]

    expect(run(creationRequest())).toEqual({ launched: 1, failed: 1 })
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('keeps a seeded terminal that already carries setup or issue work', () => {
    mocks.state.tabsByWorktree['wt-1'] = [
      { id: 'setup-tab', customTitle: null },
      { id: 'issue-tab', customTitle: null }
    ]
    mocks.state.pendingStartupByTabId['setup-tab'] = { command: 'pnpm install' }
    mocks.state.pendingIssueCommandSplitByTabId['issue-tab'] = { command: 'gh issue view 12' }

    run(creationRequest())

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('counts a failed launch and keeps launching the next entry', () => {
    mocks.launch.mockReturnValueOnce(null)

    expect(run(creationRequest())).toEqual({ launched: 1, failed: 1 })
    expect(mocks.launch).toHaveBeenCalledTimes(2)
  })

  it('counts a refused launch and asks the launch stack to notify the failure', () => {
    mocks.launch.mockReturnValueOnce({ refused: { delivered: false, failureNotified: true } })

    expect(run(creationRequest())).toEqual({ launched: 1, failed: 1 })
    // Second argument is `notifyFailure`: a refused command must surface, not vanish into the count.
    expect(mocks.launch.mock.calls[0][1]).toBe(true)
  })

  it('keeps focus out of the workspace for sequential creates', () => {
    run(creationRequest({ suppressTerminalFocusOnCompletion: true }))

    expect(mocks.launch.mock.calls[0][0]).toMatchObject({ activate: false })
  })

  it('leaves legacy requests untouched', () => {
    expect(run(creationRequest({ agentLaunches: undefined, agent: 'codex' }))).toEqual({
      launched: 0,
      failed: 0
    })
    expect(run(creationRequest({ agentLaunches: [{ agent: 'codex' }], agent: 'codex' }))).toEqual({
      launched: 0,
      failed: 0
    })
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.closeTab).not.toHaveBeenCalled()
  })
})
