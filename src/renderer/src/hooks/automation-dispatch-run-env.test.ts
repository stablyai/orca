import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation, AutomationRun } from '../../../shared/automations-types'

const mockLaunchAgentBackgroundSession = vi.fn()
const mockSubmitPromptToAgentPty = vi.fn()
const mockFindReusableAutomationSession = vi.fn()
const mockObserveExistingAutomationSession = vi.fn()
const mockMarkDispatchResult = vi.fn()

const worktree = { id: 'wt-1', displayName: 'Automation worktree', path: '/repo/worktree' }

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeView: 'terminal',
      activeWorktreeId: 'wt-active',
      activeTabId: 'tab-active',
      activeTabType: 'terminal',
      agentStatusByPaneKey: {},
      setActiveView: vi.fn(),
      setActiveWorktree: vi.fn(),
      setActiveTab: vi.fn(),
      setActiveTabType: vi.fn()
    }),
    subscribe: vi.fn(() => () => {})
  }
}))

// The workspace is not what this file is about; the run it belongs to is.
vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({
    repo: { id: 'repo-1' },
    context: { workspaceId: null, workspaceDisplayName: null, precheckResult: null }
  }),
  prepareAutomationDispatchWorkspace: async () => worktree
}))

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: mockSubmitPromptToAgentPty
}))

vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn().mockResolvedValue([])
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))

vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly triage',
  prompt: 'run this',
  precheck: null,
  agentId: 'claude',
  projectId: 'repo-1',
  executionTargetType: 'local',
  executionTargetId: 'local',
  schedulerOwner: 'local_host_service',
  workspaceMode: 'existing',
  workspaceId: 'wt-1',
  baseBranch: null,
  reuseSession: false,
  timezone: 'UTC',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  dtstart: 1,
  enabled: true,
  nextRunAt: 2,
  missedRunPolicy: 'run_once_within_grace',
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1
}

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Nightly triage 4',
  runNumber: 4,
  scheduledFor: 2,
  status: 'pending',
  trigger: 'scheduled',
  workspaceId: 'wt-1',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: null,
  terminalPaneKey: null,
  terminalPtyId: null,
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1
}

async function dispatch(reuseSession = false): Promise<void> {
  const { handleAutomationDispatchRequest } = await import('./automation-dispatch-handler')
  await handleAutomationDispatchRequest({
    automation: { ...automation, reuseSession },
    run,
    dispatchToken: 'dispatch-token'
  })
}

describe('automation dispatch run identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindReusableAutomationSession.mockReturnValue(null)
    mockLaunchAgentBackgroundSession.mockResolvedValue({
      tabId: 'agent-tab',
      paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
      ptyId: 'agent-pty',
      startupPlan: {},
      terminalOwnership: null
    })
    mockSubmitPromptToAgentPty.mockResolvedValue(true)
    mockMarkDispatchResult.mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: { automations: { markDispatchResult: mockMarkDispatchResult } },
      dispatchEvent: vi.fn()
    })
  })

  it('names the automation and the run in the agent environment', async () => {
    await dispatch()

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        launchSource: 'automation',
        env: {
          ORCA_AUTOMATION_ID: 'automation-1',
          ORCA_AUTOMATION_NAME: 'Nightly triage',
          ORCA_AUTOMATION_RUN_ID: 'run-1',
          ORCA_AUTOMATION_RUN_NUMBER: '4',
          ORCA_AUTOMATION_RUN_TRIGGER: 'scheduled'
        }
      })
    )
  })

  // A reused pane's environment was fixed when it launched, and typing into it cannot
  // change one, so the dispatch must not pretend it set anything.
  it('claims no environment for a run it types into a reused session', async () => {
    mockFindReusableAutomationSession.mockReturnValue({
      tabId: 'agent-tab',
      paneKey: 'agent-tab:7c6fb4e5-3bf1-4ff4-8259-03f7ae81c40d',
      ptyId: 'agent-pty'
    })
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})

    await dispatch(true)

    expect(mockSubmitPromptToAgentPty).toHaveBeenCalledWith({
      tabId: 'agent-tab',
      ptyId: 'agent-pty',
      content: 'run this'
    })
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
  })
})
