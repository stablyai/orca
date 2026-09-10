import { buildBrowserSurfaceReceipt } from './browser-surface-receipt'
import type { MaestroScope } from './evidence'

export function buildHarnessGraphView(p: {
  repositoryId: string
  workspacePath: string
  scope: MaestroScope
  runId: string
  generation: number
  taskId: string
  attemptId: string
  terminalHandle: string
  browserPageId: string
  browserUrl: string
  now: string
}): Record<string, unknown> {
  const workspace = {
    execution_host_id: p.scope.host,
    workspace_key: p.scope.workspace,
    kind: 'git-worktree',
    path: p.workspacePath
  }
  const empty = { count: 0, ids: [], truncated: false }
  return {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: p.repositoryId,
      canonical_root: p.workspacePath,
      execution_host: { id: p.scope.host, boundary: 'local' },
      orchestration_home: workspace,
      execution_workspace: workspace,
      base_revision: 'mwc-e2e',
      dirty_paths: [],
      run_id: p.runId,
      coordinator_generation: p.generation,
      binding_receipt_ref: 'artifact:mwc-e2e-workspace-binding.json',
      binding_receipt_hash: `sha256:${'b'.repeat(64)}`
    },
    change: 'maestro-workspace-tab-canvas',
    run_id: p.runId,
    coordinator: { id: 'mwc-codex-coordinator', generation: p.generation },
    capabilities: {
      agents: ['codex'],
      efforts: ['high'],
      placement_kinds: ['current-workspace'],
      watch_deltas: false
    },
    nodes: [
      {
        id: 'mwc-terminal-receipt',
        type: 'terminal-receipt',
        status: 'active',
        summary: 'Authenticated coordinator PTY resource',
        task_id: p.taskId,
        attempt_id: p.attemptId,
        resource: { terminal_id: p.terminalHandle, terminal_status: 'running', liveness: 'live' }
      },
      {
        id: 'mwc-browser-receipt',
        type: 'browser-surface',
        status: 'active',
        summary: 'Existing exact Browser page',
        task_id: p.taskId,
        attempt_id: p.attemptId,
        resource: buildBrowserSurfaceReceipt(p)
      }
    ],
    edges: [
      {
        id: 'mwc-worker-executes-browser',
        type: 'executes',
        source_id: 'mwc-terminal-receipt',
        target_id: 'mwc-browser-receipt'
      }
    ],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 9,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: {
      schema_version: 1,
      state: 'active',
      progress_percent: 60,
      task_counts: {
        approved: 1,
        running: 1,
        input_required: 0,
        blocked: 1,
        pending: 1,
        failed: 0
      },
      current_tasks: [{ task_id: p.taskId, attempt_id: p.attemptId, status: 'running' }],
      next_tasks: [{ task_id: 'MWC-NEXT', attempt_id: null, status: 'pending' }],
      cleanup: { pending: empty, unverifiable: empty, failed: empty, retained: empty },
      last_activity: { sequence: 9, timestamp: p.now, type: 'attempt_started' },
      blockers: [{ task_id: 'MWC-BLOCKED', attempt_id: null, finding_ref: null, cleanup_id: null }],
      material_findings: []
    }
  }
}
