import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationSession } from './automation-session-reuse'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt-1',
    workspaceDisplayName: 'Workspace',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    outputSnapshot: null,
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'previous',
    updatedAt: 10,
    stateStartedAt: 10,
    paneKey,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

describe('automation session reuse', () => {
  it('selects the latest completed live session for the same automation and workspace', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      currentRunId: 'run-current',
      runs: [
        run({ id: 'run-old', terminalSessionId: 'tab-old', createdAt: 1 }),
        run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })
      ],
      state: {
        agentStatusByPaneKey: { [paneKey]: status() },
        ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-old': ['pty-old'] },
        unifiedTabsByWorktree: {
          'wt-1': [
            { contentType: 'terminal', entityId: 'tab-1' },
            { contentType: 'terminal', entityId: 'tab-old' }
          ]
        }
      } as never
    })

    expect(session).toEqual({ tabId: 'tab-1', ptyId: 'pty-1', paneKey })
  })

  it('rejects sessions that are not idle in a live agent pane', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      currentRunId: 'run-current',
      runs: [run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })],
      state: {
        agentStatusByPaneKey: { [paneKey]: status({ state: 'working' }) },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        unifiedTabsByWorktree: {
          'wt-1': [{ contentType: 'terminal', entityId: 'tab-1' }]
        }
      } as never
    })

    expect(session).toBeNull()
  })
})
