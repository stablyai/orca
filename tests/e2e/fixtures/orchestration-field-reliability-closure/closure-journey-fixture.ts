import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import { resolveCoordinatorLaunchProfile } from '../../../../src/main/runtime/rpc/methods/orchestration-coordinator-launch-profile'
import { projectMaestroRunProgress } from '../../../../src/main/runtime/orchestration/maestro-run-progress-projection'
import {
  projectNestedAgentActivities,
  selectExactWorkerProviderSession
} from '../../../../src/main/runtime/orchestration/worker-provider-session'
import { redactWorkerTerminalLines } from '../../../../src/main/runtime/orchestration/worker-transcript-payload'
import { browserReceipt } from '../../../../src/main/runtime/rpc/methods/maestro-workspace-canvas-session-fixtures'
import type {
  DispatchContextRow,
  RunRow,
  TaskRow,
  WorkerDispatchRow
} from '../../../../src/main/runtime/orchestration/types'
import type { MaestroTerminalLease } from '../../../../src/shared/maestro-terminal-lease'

const run: RunRow = {
  id: 'run-ofc',
  objective: 'Field reliability closure',
  home_database: ':memory:',
  coordinator_handle: 'term-coordinator-g2',
  coordinator_pane_key: 'tab-coordinator:leaf-g2',
  consumer_generation: 2,
  legacy: 0,
  created_at: '2026-09-02T10:00:00.000Z',
  updated_at: '2026-09-02T10:00:00.000Z'
}

const task: TaskRow = {
  id: 'task-ofc',
  run_id: run.id,
  parent_id: null,
  created_by_terminal_handle: null,
  created_by_pane_key: null,
  created_by_process_incarnation: null,
  created_by_run_generation: null,
  task_title: 'Close field issues',
  display_name: 'Closure worker',
  spec: 'Verify every frozen field.',
  status: 'completed',
  deps: '[]',
  result: 'settled',
  completed_at: '2026-09-02T10:02:00.000Z',
  created_at: '2026-09-02T10:00:01.000Z',
  operational_outcome: null
}

const dispatch: DispatchContextRow = {
  id: 'dispatch-ofc',
  run_id: run.id,
  task_id: task.id,
  contract_version: 1,
  launch_token_hash: 'hash',
  assignee_handle: 'term-worker',
  assignee_pane_key: 'tab-worker:leaf',
  capability_hash: 'capability',
  process_incarnation: 'pty-worker:1',
  capability_revoked_at: null,
  status: 'completed',
  failure_count: 0,
  last_failure: null,
  termination_reason: null,
  depth: 1,
  dispatched_at: '2026-09-02T10:00:00.000Z',
  completed_at: '2026-09-02T10:02:00.000Z',
  created_at: '2026-09-02T10:00:00.000Z',
  last_heartbeat_at: '2026-09-02T10:01:00.000Z'
}

const worker: WorkerDispatchRow = {
  dispatch_id: dispatch.id,
  runtime_epoch: 'runtime-ofc',
  state: 'succeeded',
  stage: 'ready',
  worktree_id: 'folder:ofc',
  agent_terminal_handle: 'term-worker',
  setup_state: 'ready',
  effects: '[]',
  residual_resources: '[]',
  start_options: '{}',
  last_error: null,
  created_at: dispatch.created_at,
  updated_at: dispatch.completed_at!
}

const terminalLease: MaestroTerminalLease = {
  id: 'lease-ofc',
  requestId: 'request-ofc',
  executionHostId: 'local',
  workspaceKey: 'folder:ofc',
  terminalHandle: 'term-worker',
  tabId: 'tab-worker',
  paneKey: 'tab-worker:leaf',
  ptyIncarnation: 'pty-worker:1',
  processRootId: 'process-worker',
  runId: run.id,
  taskId: task.id,
  attemptId: 'attempt-ofc',
  coordinatorGeneration: null,
  role: 'worker',
  workerTerminalResourceId: 'resource-ofc',
  coordinatorRunId: null,
  title: 'Closure worker',
  launchProfile: {
    agent: 'codex',
    model: 'gpt-5',
    effort: 'high',
    permissionMode: 'default',
    routeRef: null
  },
  parentLeaseId: null,
  spawnedBy: 'coordinator:g2',
  ownerPrincipal: `dispatch:${dispatch.id}`,
  retentionPolicy: 'auto_release',
  lifecycleState: 'settled',
  observation: null,
  providerSessionId: 'provider-ofc',
  capsuleDigest: null,
  cleanupReceipt: null,
  archivedTail: null,
  createdAt: '2026-09-02T10:00:00.000Z',
  updatedAt: '2026-09-02T10:02:00.000Z'
}

function progress(revision: number) {
  return projectMaestroRunProgress({
    run,
    tasks: [task],
    dispatches: [dispatch],
    messages: [],
    terminalLeases: [terminalLease],
    workerDispatches: [worker],
    browserSurfaces: [browserReceipt({ runId: run.id, taskId: task.id, attemptId: dispatch.id })],
    providerExecutions: [
      {
        dispatchId: dispatch.id,
        session: {
          paneKey: dispatch.assignee_pane_key!,
          processIncarnation: dispatch.process_incarnation!,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'provider-ofc' },
          observedAt: Date.parse('2026-09-02T10:01:00.000Z')
        }
      }
    ],
    nestedActivity: [
      {
        parent_dispatch_id: dispatch.id,
        parent_provider_session_id: 'provider-ofc',
        provider_child_id: 'child-ofc',
        provider: 'codex',
        type: 'reviewer',
        model: 'gpt-5',
        description: 'Nested reviewer',
        state: 'completed',
        started_at: '2026-09-02T10:00:30.000Z',
        updated_at: '2026-09-02T10:01:30.000Z',
        completed_at: '2026-09-02T10:01:30.000Z'
      }
    ],
    executionHostId: 'local',
    workspaceKey: 'folder:ofc',
    revision,
    projectionHealth: { state: 'healthy', revision },
    cleanupHealth: { state: 'clean', count: 0 },
    recoveredAuthority: revision > 1,
    browserSurfaceKeys: new Map([['browser-page-1', 'browser:ofc']])
  })
}

export function exerciseFieldReliabilityClosure() {
  const root = mkdtempSync(join(tmpdir(), 'orca-ofc-'))
  const databasePath = join(root, 'orchestration.sqlite')
  let database = new OrchestrationDb(databasePath)
  const created = database.createRun({
    objective: run.objective,
    coordinatorHandle: 'term-coordinator-g1',
    coordinatorPaneKey: 'tab-coordinator:leaf-g1'
  })
  const takeover = database.bindRun({
    runId: created.id,
    coordinatorHandle: run.coordinator_handle!,
    coordinatorPaneKey: run.coordinator_pane_key!
  })
  database.close()
  database = new OrchestrationDb(databasePath)
  const rebound = database.bindRun({
    runId: created.id,
    coordinatorHandle: 'term-coordinator-g3',
    coordinatorPaneKey: 'tab-coordinator:leaf-g3'
  })
  database.close()
  rmSync(root, { recursive: true, force: true })
  const rootAbsent = !existsSync(root)

  const selected = selectExactWorkerProviderSession({
    paneKey: dispatch.assignee_pane_key!,
    processIncarnation: dispatch.process_incarnation!,
    connectionId: null,
    launchToken: null,
    observedAfter: 0,
    statuses: [
      {
        paneKey: dispatch.assignee_pane_key!,
        connectionId: null,
        launchToken: null,
        providerSessionOnly: false,
        providerSession: { key: 'session_id', id: 'provider-ofc' },
        agentType: 'codex',
        receivedAt: 10,
        subagents: [{ id: 'child-ofc', state: 'idle', startedAt: 5, agentType: 'reviewer' }]
      }
    ]
  })
  const nested = selected
    ? projectNestedAgentActivities({ dispatchId: dispatch.id, session: selected })
    : []
  const launch = resolveCoordinatorLaunchProfile({
    agent: 'codex',
    model: 'gpt-5',
    effort: 'high',
    settings: {}
  })
  const redaction = redactWorkerTerminalLines(['token=sk-secret password=hunter2'])
  const active = progress(1)
  const refreshed = progress(2)
  const unavailableBrowser = browserReceipt({
    runId: run.id,
    taskId: task.id,
    attemptId: dispatch.id
  })
  unavailableBrowser.state = 'unavailable'
  unavailableBrowser.observed_visibility = 'unavailable'
  unavailableBrowser.focus_receipt.unavailable_reason = 'Managed Browser surface is unavailable.'
  return {
    authority: {
      takeoverGeneration: takeover?.consumer_generation,
      reboundHandle: rebound?.coordinator_handle
    },
    restartAndRebind: rebound?.consumer_generation,
    effectiveProfile: launch.effectiveProfile,
    workerSettlement: active.execution,
    projectionRefresh: [active.technical.revision, refreshed.technical.revision],
    nestedParent: nested[0]?.parent_provider_session_id,
    resourceKinds: [...new Set(refreshed.resources?.map((resource) => resource.kind))],
    resourceParents: refreshed.resources
      ?.filter((resource) => ['provider', 'terminal', 'browser'].includes(resource.kind))
      .map((resource) => [resource.kind, resource.parent_reference] as const),
    browser: {
      navigationOwned: browserReceipt().ownership === 'harness',
      disabledReason: unavailableBrowser.focus_receipt.unavailable_reason
    },
    redacted: redaction.lines,
    cleanup: { removed: true, rootAbsent }
  }
}
