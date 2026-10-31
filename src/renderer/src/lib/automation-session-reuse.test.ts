import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AutomationRun } from '../../../shared/automations-types'
import { findReusableAutomationSession } from './automation-session-reuse'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const splitLeafId = '22222222-2222-4222-8222-222222222222'
const splitPaneKey = `tab-1:${splitLeafId}`

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
    terminalPaneKey: paneKey,
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
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

describe('automation session reuse in the renderer store', () => {
  it.each(['wt-1', 'folder:dup'])(
    'uses exact live ownership with retained history, including legacy local and encoded remote panes (%s)',
    (worktreeId) => {
      const physical = { hostId: 'local', repoId: 'repo-1', path: '/repo' } as const
      const context = {
        kind: 'workspace-run',
        projectId: 'removed-project',
        projectHostSetupId: 'replaced-setup',
        ...physical
      } as const
      function select(
        hostId: 'local' | 'ssh:old' | 'runtime:server',
        ptyId: string,
        liveHost?: string,
        runContext?: AutomationRun['runContext']
      ) {
        return findReusableAutomationSession({
          automationId: 'auto-1',
          agentId: 'claude',
          worktreeId,
          currentRunId: 'current',
          target: { ...physical, hostId },
          runs: [run({ workspaceId: worktreeId, terminalPtyId: ptyId, runContext })],
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only these inventory/status fields.
          state: {
            agentStatusByPaneKey: { [paneKey]: status({ agentType: 'unknown' }) },
            ptyIdsByTabId: { 'tab-1': [ptyId] },
            terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [leafId]: ptyId } } },
            unifiedTabsByWorktree: {
              [worktreeId]: [
                { contentType: 'terminal', entityId: 'tab-1', executionHostId: liveHost }
              ]
            }
          } as never
        })
      }
      expect(select('local', 'pty-1')).not.toBeNull()
      expect(select('local', 'pty-1', 'local', context)).not.toBeNull()
      expect(select('ssh:old', 'ssh:old@@pty-1', 'ssh:old')).not.toBeNull()
      expect(select('runtime:server', 'remote:server@@term_1', 'runtime:server')).not.toBeNull()
      expect(select('ssh:old', 'pty-1', 'local', context)).toBeNull()
      expect(select('local', 'pty-1', 'ssh:old', context)).toBeNull()
      expect(select('local', 'ssh:broken')).toBeNull()
      expect(select('local', 'remote:foreign')).toBeNull()
      expect(select('local', 'pty-1', 'local', { ...context, path: '/other' })).toBeNull()
    }
  )

  it('uses the PTY recorded for the exact split-pane run', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      target: { hostId: 'local', repoId: 'repo-1', path: '/repo' },
      currentRunId: 'run-current',
      runs: [
        run({
          id: 'run-new',
          terminalSessionId: 'tab-1',
          terminalPaneKey: splitPaneKey,
          terminalPtyId: 'pty-right',
          createdAt: 2
        })
      ],
      state: {
        agentStatusByPaneKey: {
          [splitPaneKey]: status({ paneKey: splitPaneKey })
        },
        ptyIdsByTabId: { 'tab-1': ['pty-left', 'pty-right'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            ptyIdsByLeafId: {
              [leafId]: 'pty-left',
              [splitLeafId]: 'pty-right'
            }
          }
        },
        unifiedTabsByWorktree: {
          'wt-1': [{ contentType: 'terminal', entityId: 'tab-1' }]
        }
      } as never
    })

    expect(session).toEqual({ tabId: 'tab-1', ptyId: 'pty-right', paneKey: splitPaneKey })
  })

  it('does not reuse an unrelated split pane for a run with exact pane identity', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      target: { hostId: 'local', repoId: 'repo-1', path: '/repo' },
      currentRunId: 'run-current',
      runs: [run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })],
      state: {
        agentStatusByPaneKey: {
          [splitPaneKey]: status({ paneKey: splitPaneKey })
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-right'] },
        terminalLayoutsByTabId: {
          'tab-1': {
            ptyIdsByLeafId: {
              [leafId]: 'pty-1',
              [splitLeafId]: 'pty-right'
            }
          }
        },
        unifiedTabsByWorktree: {
          'wt-1': [{ contentType: 'terminal', entityId: 'tab-1' }]
        }
      } as never
    })

    expect(session).toBeNull()
  })

  it('rejects an exact run pane when its PTY is no longer live', () => {
    const session = findReusableAutomationSession({
      automationId: 'auto-1',
      agentId: 'claude',
      worktreeId: 'wt-1',
      target: { hostId: 'local', repoId: 'repo-1', path: '/repo' },
      currentRunId: 'run-current',
      runs: [run({ id: 'run-new', terminalSessionId: 'tab-1', createdAt: 2 })],
      state: {
        agentStatusByPaneKey: { [paneKey]: status() },
        ptyIdsByTabId: { 'tab-1': ['pty-other'] },
        terminalLayoutsByTabId: { 'tab-1': { ptyIdsByLeafId: { [leafId]: 'pty-1' } } },
        unifiedTabsByWorktree: {
          'wt-1': [{ contentType: 'terminal', entityId: 'tab-1' }]
        }
      } as never
    })

    expect(session).toBeNull()
  })
})
