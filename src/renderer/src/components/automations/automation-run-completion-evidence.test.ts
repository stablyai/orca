import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { hasAutomationRunCompletionEvidence } from './automation-run-completion-evidence'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function run(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'dispatched',
    trigger: 'manual',
    workspaceId: 'wt-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: PANE,
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: 1_000,
    dispatchedAt: 1_000,
    createdAt: 1_000
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: PANE,
    state: 'done',
    prompt: '',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function retained(status: AgentStatusEntry): RetainedAgentEntry {
  return {
    entry: status,
    worktreeId: 'wt-1',
    tab: {
      id: 'tab-1',
      ptyId: 'pty-1',
      worktreeId: 'wt-1',
      title: 'Agent',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1_000
    },
    agentType: 'claude',
    startedAt: status.stateStartedAt
  }
}

describe('automation run completion evidence (STA-3386)', () => {
  it('ignores live and retained session-boundary done rows', () => {
    const boundary = entry({ sessionBoundary: true })
    expect(
      hasAutomationRunCompletionEvidence({
        run: run(),
        dispatchedAt: 1_000,
        agentStatusByPaneKey: { [PANE]: boundary },
        retainedAgentsByPaneKey: { [PANE]: retained(boundary) }
      })
    ).toBe(false)
  })

  it('accepts a real done after dispatch', () => {
    expect(
      hasAutomationRunCompletionEvidence({
        run: run(),
        dispatchedAt: 1_000,
        agentStatusByPaneKey: { [PANE]: entry() },
        retainedAgentsByPaneKey: {}
      })
    ).toBe(true)
  })
})
