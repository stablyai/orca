import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { selectOrchestrationStatusRun } from './orchestration-status-selection'

const NOW = 2_000_000_000
const LEAF_ONE = '11111111-1111-4111-8111-111111111111'
const LEAF_TWO = '22222222-2222-4222-8222-222222222222'
const LEAF_THREE = '33333333-3333-4333-8333-333333333333'
const PANE_ONE = makePaneKey('tab-1', LEAF_ONE)
const PANE_TWO = makePaneKey('tab-2', LEAF_TWO)
const PANE_THREE = makePaneKey('tab-3', LEAF_THREE)

function paneBindings(bindings: readonly [string, string][]) {
  const terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId: Record<string, string> }> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  for (const [paneKey, ptyId] of bindings) {
    const [tabId, leafId] = paneKey.split(':')
    terminalLayoutsByTabId[tabId] = { ptyIdsByLeafId: { [leafId]: ptyId } }
    ptyIdsByTabId[tabId] = [ptyId]
  }
  return { terminalLayoutsByTabId, ptyIdsByTabId }
}

function status(runId: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: PANE_ONE,
    worktreeId: 'wt-1',
    connectionId: null,
    stateHistory: [],
    orchestration: { taskId: 'task-1', dispatchId: 'dispatch-1', orchestrationRunId: runId },
    ...overrides
  }
}

function worktreeLineage(runId: string): WorktreeLineage {
  return {
    worktreeId: 'wt-1',
    worktreeInstanceId: 'instance-1',
    parentWorktreeId: 'parent',
    parentWorktreeInstanceId: 'parent-instance',
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    orchestrationRunId: runId,
    createdAt: 1
  }
}

function workspaceLineage(runId: string): WorkspaceLineage {
  return {
    childWorkspaceKey: 'worktree:wt-1',
    childInstanceId: 'instance-1',
    parentWorkspaceKey: 'worktree:parent',
    parentInstanceId: 'parent-instance',
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    orchestrationRunId: runId,
    createdAt: 1
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    activeWorkspaceKey: 'worktree:wt-1' as const,
    activeWorktreeId: 'wt-1',
    activeWorktreeInstanceId: 'instance-1',
    activeExecutionHostId: 'local' as const,
    now: NOW,
    agentStatuses: [] as AgentStatusEntry[],
    ...paneBindings([[PANE_ONE, 'pty-local-1']]),
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  }
}

describe('selectOrchestrationStatusRun', () => {
  it('prefers the active workspace live run over lineage', () => {
    expect(
      selectOrchestrationStatusRun(
        input({
          agentStatuses: [status('run-live')],
          worktreeLineageById: { 'wt-1': worktreeLineage('run-old') }
        })
      )
    ).toEqual({ kind: 'selected', runId: 'run-live', source: 'live' })
  })

  it('uses instance-verified lineage when no live run is available', () => {
    expect(
      selectOrchestrationStatusRun(
        input({ workspaceLineageByChildKey: { 'worktree:wt-1': workspaceLineage('run-1') } })
      )
    ).toEqual({ kind: 'selected', runId: 'run-1', source: 'lineage' })
  })

  it('fails closed for reused workspace paths and unrelated hosts', () => {
    expect(
      selectOrchestrationStatusRun(
        input({
          activeWorktreeInstanceId: 'new-instance',
          agentStatuses: [status('run-ssh', { connectionId: 'ssh-a' })],
          worktreeLineageById: { 'wt-1': worktreeLineage('run-old') }
        })
      )
    ).toEqual({ kind: 'none' })
  })

  it('accepts only the selected SSH host and reports multiple live runs as ambiguous', () => {
    expect(
      selectOrchestrationStatusRun(
        input({
          activeExecutionHostId: 'ssh:ssh-a',
          agentStatuses: [
            status('run-a', { connectionId: 'ssh-a' }),
            status('run-b', { paneKey: PANE_TWO, connectionId: 'ssh-a' }),
            status('run-other-host', { paneKey: PANE_THREE, connectionId: 'ssh-b' })
          ],
          ...paneBindings([
            [PANE_ONE, toAppSshPtyId('ssh-a', 'pty-1')],
            [PANE_TWO, toAppSshPtyId('ssh-a', 'pty-2')],
            [PANE_THREE, toAppSshPtyId('ssh-b', 'pty-3')]
          ])
        })
      )
    ).toEqual({ kind: 'ambiguous', runIds: ['run-a', 'run-b'] })
  })

  it('does not treat completed agent rows as active selection evidence', () => {
    expect(
      selectOrchestrationStatusRun(
        input({ agentStatuses: [status('run-done', { state: 'done' })] })
      )
    ).toEqual({ kind: 'none' })
  })

  it('accepts the exact freshness boundary and invalidates immediately after it', () => {
    const boundaryStatus = status('run-live', {
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS
    })
    expect(selectOrchestrationStatusRun(input({ agentStatuses: [boundaryStatus] }))).toEqual({
      kind: 'selected',
      runId: 'run-live',
      source: 'live'
    })
    expect(
      selectOrchestrationStatusRun(input({ agentStatuses: [boundaryStatus], now: NOW + 1 }))
    ).toEqual({ kind: 'none' })
  })

  it('fails closed when local and runtime workspaces share the same path identity', () => {
    expect(
      selectOrchestrationStatusRun(
        input({
          activeExecutionHostId: 'runtime:env-1',
          agentStatuses: [status('run-local', { connectionId: null })],
          ...paneBindings([[PANE_ONE, 'pty-local-1']])
        })
      )
    ).toEqual({ kind: 'none' })

    expect(
      selectOrchestrationStatusRun(
        input({
          activeExecutionHostId: 'runtime:env-1',
          agentStatuses: [status('run-runtime', { connectionId: null })],
          ...paneBindings([[PANE_ONE, toRemoteRuntimePtyId('term-1', 'env-1')]])
        })
      )
    ).toEqual({ kind: 'selected', runId: 'run-runtime', source: 'live' })
  })

  it('rejects a local row without explicit transport ownership', () => {
    expect(
      selectOrchestrationStatusRun(
        input({ agentStatuses: [status('run-unproven', { connectionId: undefined })] })
      )
    ).toEqual({ kind: 'none' })
  })
})
