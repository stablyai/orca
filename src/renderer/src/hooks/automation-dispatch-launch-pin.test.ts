import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockLaunchAgentBackgroundSession, mockMarkDispatchResult } = vi.hoisted(() => ({
  mockLaunchAgentBackgroundSession: vi.fn(),
  mockMarkDispatchResult: vi.fn()
}))

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({}) }
}))

vi.mock('./automation-dispatch-workspace', () => ({
  resolveAutomationDispatchWorkspace: () => ({
    repo: { id: 'repo-1' },
    context: { workspaceId: 'wt-1', workspaceDisplayName: 'wt', precheckResult: null }
  }),
  prepareAutomationDispatchWorkspace: async () => ({
    id: 'wt-1',
    displayName: 'wt'
  })
}))

vi.mock('./automation-dispatch-completion', () => ({
  createAutomationDispatchCompletion: () => ({
    appendOutput: vi.fn(),
    captureAssistantMessage: vi.fn(),
    handleAgentDone: vi.fn(),
    handleExit: vi.fn(),
    observeAgentStatus: vi.fn(),
    cleanupRunObservers: vi.fn(),
    settlePendingAfterDispatch: async () => {}
  })
}))

import type { Automation, AutomationRun } from '../../../shared/automations-types'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'

const automation: Automation = {
  id: 'automation-1',
  name: 'Nightly',
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
  title: 'Nightly run 1',
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
  launchRequest: null,
  error: null,
  startedAt: null,
  dispatchedAt: null,
  createdAt: 1
}

async function dispatch(pinned: Partial<Automation> = {}): Promise<void> {
  await handleAutomationDispatchRequest({
    automation: { ...automation, ...pinned },
    run,
    dispatchToken: 'dispatch-token'
  })
}

describe('automation dispatch launch pin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLaunchAgentBackgroundSession.mockResolvedValue({
      tabId: 'agent-tab',
      paneKey: 'agent-tab:leaf',
      ptyId: 'agent-pty',
      startupPlan: {},
      terminalOwnership: null
    })
    vi.stubGlobal('window', {
      api: { automations: { markDispatchResult: mockMarkDispatchResult } }
    })
  })

  it('launches a pinned model and effort as session options', async () => {
    await dispatch({ model: 'opus', effort: 'high' })

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionOptions: { model: 'opus', effort: 'high' } })
    )
  })

  it('leaves session options off an automation on the agent default', async () => {
    await dispatch()

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession.mock.calls[0][0]).not.toHaveProperty('sessionOptions')
  })
})
