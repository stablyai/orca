import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchAgentInNewTabArgs } from '@/lib/launch-agent-in-new-tab'
import type { LaunchAgentInNewTabResult } from '@/lib/launch-agent-in-new-tab-host-agents'
import type { AgentLaunchListEntry, WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { runComposerAgentLaunchLoop } from './composer-agent-launch-loop'

const mocks = vi.hoisted(() => ({
  launch: vi.fn<(args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult>(),
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
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))

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
  mocks.launch.mockReturnValue({
    surface: { kind: 'local-terminal', tabId: 'agent-tab' },
    pasteDraftAfterLaunch: false
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

  it('closes the seeded blank terminal before launching', () => {
    mocks.state.tabsByWorktree['wt-1'] = [{ id: 'blank-tab', customTitle: null }]

    run(creationRequest())

    expect(mocks.closeTab).toHaveBeenCalledWith('blank-tab', { captureRecentlyClosed: false })
    expect(mocks.closeTab.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launch.mock.invocationCallOrder[0]
    )
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
