import { describe, expect, it } from 'vitest'
import {
  applyAgentGraphDelta,
  parseAgentGraphProjection,
  projectAgentGraphView,
  withRuntimeMaestroRunProgress
} from './maestro-projection'

const scope = {
  schema_version: 1 as const,
  repository_id: 'repository-1',
  canonical_root: '/workspace',
  execution_host: { id: 'host-local', boundary: 'local' as const },
  orchestration_home: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:folder-local-01',
    kind: 'folder' as const,
    path: '/workspace'
  },
  execution_workspace: {
    execution_host_id: 'host-local',
    workspace_key: 'folder:folder-local-01',
    kind: 'folder' as const,
    path: '/workspace'
  },
  base_revision: 'revision-1',
  dirty_paths: [],
  run_id: 'run-1',
  coordinator_generation: 1,
  binding_receipt_ref: 'artifact:workspace-bootstrap.json',
  binding_receipt_hash: `sha256:${'a'.repeat(64)}`
}
function view(kind: 'snapshot' | 'delta' = 'snapshot') {
  return {
    schema_version: 1 as const,
    protocol: 'agent-graph-view/v1' as const,
    kind,
    workspace_scope: scope,
    change: 'change-1',
    run_id: 'run-1',
    coordinator: { id: 'coordinator-1', generation: 1 },
    capabilities: {
      agents: ['codex'],
      efforts: ['high' as const],
      placement_kinds: ['current-workspace' as const],
      watch_deltas: true
    },
    nodes: [
      {
        id: 'attempt-1',
        type: 'attempt' as const,
        status: 'running',
        summary: 'Implement contract',
        task_id: 'task-1',
        attempt_id: 'attempt-1',
        profile: {
          requested: { agent: 'codex', model: 'requested', effort: 'high' },
          resolved: { agent: 'codex', model: 'resolved', effort: 'high' }
        }
      },
      {
        id: 'terminal-1',
        type: 'terminal-receipt' as const,
        status: 'running',
        summary: 'Codex terminal',
        attempt_id: 'attempt-1',
        resource: {
          attempt_id: 'attempt-1',
          terminal_id: 'pty-1',
          terminal_status: 'running',
          liveness: 'live'
        }
      }
    ],
    edges: [
      {
        id: 'edge-executes-1',
        type: 'executes' as const,
        source_id: 'attempt-1',
        target_id: 'terminal-1'
      }
    ],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: kind === 'snapshot' ? 1 : 2,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: {
      schema_version: 1 as const,
      state: 'active' as const,
      progress_percent: 10,
      task_counts: {
        approved: 0,
        running: 1,
        input_required: 0,
        blocked: 0,
        pending: 1,
        failed: 0
      },
      current_tasks: [{ task_id: 'task-1', attempt_id: 'attempt-1', status: 'running' as const }],
      next_tasks: [{ task_id: 'task-2', attempt_id: null, status: 'pending' as const }],
      cleanup: {
        pending: { count: 0, ids: [], truncated: false },
        unverifiable: { count: 0, ids: [], truncated: false },
        failed: { count: 0, ids: [], truncated: false },
        retained: { count: 0, ids: [], truncated: false }
      },
      last_activity: { sequence: 4, timestamp: '2026-08-22T09:04:01Z', type: 'attempt_started' },
      blockers: [],
      material_findings: []
    }
  }
}
describe('Maestro projection contract', () => {
  it('preserves an explicit unverifiable verdict over a stale live terminal status', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: input.nodes.map((node) =>
          node.type === 'terminal-receipt'
            ? {
                ...node,
                resource: { ...node.resource, terminal_status: 'live', liveness: 'unverifiable' }
              }
            : node
        )
      })
    )
    expect(result.nodes.find((node) => node.id === 'attempt-1')?.live).toBe(false)
  })
  it('projects provider profiles and concrete live state', () => {
    const result = projectAgentGraphView(parseAgentGraphProjection(view()))

    expect({
      repositoryId: result.repositoryId,
      runId: result.runId,
      executionHostId: result.workspace.executionHostId,
      workspaceKey: result.workspace.workspaceKey
    }).toEqual({
      repositoryId: scope.repository_id,
      runId: scope.run_id,
      executionHostId: scope.execution_workspace.execution_host_id,
      workspaceKey: scope.execution_workspace.workspace_key
    })
    expect(result.nodes[0]).toMatchObject({
      requestedAgent: 'codex',
      resolvedAgent: 'codex',
      resolvedModel: 'resolved',
      status: 'Running',
      terminalId: 'pty-1',
      live: true
    })
  })
  it('requires a live terminal receipt instead of inferring liveness from attempt status', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: input.nodes.filter((node) => node.type !== 'terminal-receipt'),
        edges: []
      })
    )

    expect(result.nodes.find((node) => node.id === 'attempt-1')).toMatchObject({
      terminalId: undefined,
      live: false
    })
  })
  it('does not treat a running terminal status as a liveness observation', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: input.nodes.map((node) =>
          node.type === 'terminal-receipt'
            ? {
                ...node,
                resource: {
                  attempt_id: 'attempt-1',
                  terminal_id: 'pty-1',
                  terminal_status: 'running'
                }
              }
            : node
        )
      })
    )

    expect(result.nodes.find((node) => node.id === 'attempt-1')).toMatchObject({
      terminalId: 'pty-1',
      live: false
    })
  })
  it('maps a dispatched task and explicit live terminal status', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: [
          {
            id: 'task-1',
            type: 'task',
            status: 'dispatched',
            summary: 'Implement contract',
            task_id: 'task-1'
          },
          input.nodes[0],
          {
            ...input.nodes[1],
            status: 'live',
            task_id: 'task-1',
            resource: {
              attempt_id: 'attempt-1',
              terminal_id: 'pty-1',
              terminal_status: 'live'
            }
          }
        ],
        edges: [
          ...input.edges,
          {
            id: 'edge-reports-1',
            type: 'reports_to',
            source_id: 'attempt-1',
            target_id: 'task-1'
          }
        ]
      })
    )

    expect(result.nodes.find((node) => node.id === 'task-1')).toMatchObject({
      status: 'Running',
      terminalId: 'pty-1',
      live: true
    })
    expect(result.nodes.find((node) => node.id === 'attempt-1')).toMatchObject({
      terminalId: 'pty-1',
      live: true
    })
    expect(result.nodes.find((node) => node.id === 'terminal-1')).toMatchObject({
      status: 'Running',
      terminalId: 'pty-1',
      live: true
    })
  })
  it('preserves terminal identity when an optional liveness value is unsupported', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: input.nodes.map((node) =>
          node.type === 'terminal-receipt'
            ? {
                ...node,
                resource: {
                  attempt_id: 'attempt-1',
                  terminal_id: 'pty-1',
                  terminal_status: 'running',
                  liveness: 'verified'
                }
              }
            : node
        )
      })
    )

    expect(result.nodes.find((node) => node.id === 'attempt-1')).toMatchObject({
      terminalId: 'pty-1',
      terminalStatus: 'running',
      live: false
    })
  })
  it('replaces a failed historical attempt with the successful retry', () => {
    const input = view()
    const result = projectAgentGraphView(
      parseAgentGraphProjection({
        ...input,
        nodes: [
          {
            id: 'task-1',
            type: 'task',
            status: 'completed',
            summary: 'Implement contract',
            task_id: 'task-1'
          },
          {
            id: 'attempt-failed',
            type: 'attempt',
            status: 'failed',
            summary: 'Failed attempt',
            task_id: 'task-1',
            attempt_id: 'attempt-failed'
          },
          {
            id: 'terminal-failed',
            type: 'terminal-receipt',
            status: 'exited',
            summary: 'Failed terminal',
            task_id: 'task-1',
            attempt_id: 'attempt-failed',
            resource: {
              attempt_id: 'attempt-failed',
              terminal_id: 'pty-failed',
              terminal_status: 'exited',
              liveness: 'exited'
            }
          },
          {
            id: 'attempt-successful',
            type: 'attempt',
            status: 'completed',
            summary: 'Successful retry',
            task_id: 'task-1',
            attempt_id: 'attempt-successful'
          },
          {
            id: 'terminal-successful',
            type: 'terminal-receipt',
            status: 'exited',
            summary: 'Successful terminal',
            task_id: 'task-1',
            attempt_id: 'attempt-successful',
            resource: {
              attempt_id: 'attempt-successful',
              terminal_id: 'pty-successful',
              terminal_status: 'exited',
              liveness: 'exited'
            }
          }
        ],
        edges: [
          {
            id: 'edge-failed',
            type: 'executes',
            source_id: 'attempt-failed',
            target_id: 'terminal-failed'
          },
          {
            id: 'edge-successful',
            type: 'executes',
            source_id: 'attempt-successful',
            target_id: 'terminal-successful'
          }
        ]
      })
    )

    expect(result.nodes.map((node) => node.id)).toEqual([
      'task-1',
      'attempt-successful',
      'terminal-successful'
    ])
    expect(result.edges.map((edge) => edge.id)).toEqual(['edge-successful'])
  })
  it('preserves the graph when required progress is structurally invalid', () => {
    const input = view()
    const invalidProgress = parseAgentGraphProjection({
      ...input,
      progress: { ...input.progress, schema_version: 2 }
    })
    const missingProgress = parseAgentGraphProjection({ ...input, progress: undefined })

    expect(projectAgentGraphView(invalidProgress).nodes).toHaveLength(input.nodes.length)
    expect(projectAgentGraphView(invalidProgress).runProgress).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
    expect(projectAgentGraphView(missingProgress).nodes).toHaveLength(input.nodes.length)
    expect(projectAgentGraphView(missingProgress).runProgress).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
  })
  it('requires the negotiated version and matching run authority for progress', () => {
    const input = view()
    const unsupported = parseAgentGraphProjection({
      ...input,
      progress: { ...input.progress, schema_version: 2 }
    })
    const mismatchedRun = parseAgentGraphProjection({
      ...input,
      run_id: 'run-2'
    })

    expect(projectAgentGraphView(unsupported).runProgress).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
    expect(projectAgentGraphView(mismatchedRun).runProgress).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
  })
  it('sanitizes oversized and extra-field progress before projection', () => {
    const input = view()
    const parsed = parseAgentGraphProjection({
      ...input,
      progress: {
        ...input.progress,
        extra: 'discarded',
        blockers: Array.from({ length: 6 }, () => ({
          task_id: null,
          attempt_id: null,
          finding_ref: null,
          cleanup_id: null
        }))
      }
    })

    expect(parsed.progress).toBeUndefined()
    expect(parsed.nodes).toEqual(input.nodes)
    expect(projectAgentGraphView(parsed).runProgress).toEqual({
      available: false,
      state: 'outcome_unknown'
    })
  })
  it('projects portals and local nodes without merging workspace documents', () => {
    const input = view()
    const workspaceScope = {
      ...scope,
      execution_host: { id: 'ssh:remote-1', boundary: 'remote' as const },
      execution_workspace: {
        execution_host_id: 'ssh:remote-1',
        workspace_key: 'worktree:repository-1::remote-child',
        kind: 'git-worktree' as const,
        path: '/remote/child',
        worktree_path: '/remote/child'
      }
    }
    const nodes = [
      {
        id: 'task-1',
        type: 'task' as const,
        status: 'running',
        summary: 'Coordinate remote work',
        task_id: 'task-1'
      },
      {
        id: 'portal-1',
        type: 'portal' as const,
        status: 'running',
        summary: 'Remote child workspace'
      },
      ...input.nodes.map((node) =>
        node.id === 'attempt-1'
          ? {
              ...node,
              profile: {
                ...node.profile,
                resolved_placement: workspaceScope.execution_workspace
              }
            }
          : node
      )
    ]
    const parsed = parseAgentGraphProjection({ ...input, workspace_scope: workspaceScope, nodes })
    const home = projectAgentGraphView(parsed, {
      executionHostId: scope.orchestration_home.execution_host_id,
      workspaceKey: scope.orchestration_home.workspace_key
    })
    const remote = projectAgentGraphView(parsed, {
      executionHostId: workspaceScope.execution_workspace.execution_host_id,
      workspaceKey: workspaceScope.execution_workspace.workspace_key
    })

    expect(home.nodes.map((node) => node.id)).toEqual(['task-1', 'portal-1'])
    expect(remote.nodes.map((node) => node.id)).toEqual(['portal-1', 'attempt-1', 'terminal-1'])
    expect(home.materialization).toMatchObject({
      accepted: { nodes: 4 },
      materialized: { nodes: 2 },
      excludedNodes: [
        { id: 'attempt-1', reason: 'workspace_mismatch' },
        { id: 'terminal-1', reason: 'workspace_mismatch' }
      ]
    })
    expect(home.nodes.find((node) => node.id === 'portal-1')).toMatchObject({
      portalDirection: 'to-execution',
      destinationExecutionHostId: 'ssh:remote-1',
      destinationWorkspaceKey: 'worktree:repository-1::remote-child'
    })
    expect(remote.nodes.find((node) => node.id === 'portal-1')).toMatchObject({
      portalDirection: 'back-to-home',
      destinationExecutionHostId: 'host-local',
      destinationWorkspaceKey: 'folder:folder-local-01'
    })
    expect(home.runProgress).toMatchObject({
      available: true,
      authority: { workspace: { workspaceKey: 'folder:folder-local-01' } }
    })
    expect(remote.runProgress).toMatchObject({
      available: true,
      authority: { workspace: { workspaceKey: 'worktree:repository-1::remote-child' } }
    })
  })
  it('applies bounded deltas without retaining removed nodes', () => {
    const previous = parseAgentGraphProjection(view())
    const delta = parseAgentGraphProjection({
      ...view('delta'),
      nodes: [],
      edges: [],
      removed_node_ids: ['attempt-1'],
      removed_edge_ids: ['edge-executes-1']
    })

    expect(applyAgentGraphDelta(previous, delta).nodes.map((node) => node.id)).toEqual([
      'terminal-1'
    ])
  })
  it('rejects malformed graph identifiers', () => {
    expect(() => parseAgentGraphProjection({ ...view(), change: 'bad id' })).toThrow()
  })

  it('attaches runtime-owned v2 progress only to its exact projected authority', () => {
    const projection = projectAgentGraphView(parseAgentGraphProjection(view()))
    const progress = {
      schema_version: 2 as const,
      run: { id: projection.runId, title: 'Implement contract' },
      execution: {
        state: 'active' as const,
        progress_percent: 0,
        completed: 0,
        total: 1,
        counts: {
          pending: 0,
          running: 1,
          input_required: 0,
          blocked: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0
        }
      },
      projection_health: { state: 'healthy' as const, revision: projection.revision },
      cleanup_health: { state: 'clean' as const, count: 0 },
      current: [
        {
          reference: 'task-1',
          title: 'Implement contract',
          state: 'running' as const,
          activity_summary: 'Running focused validation'
        }
      ],
      recently_completed: [],
      next: [],
      blocked: [],
      nested_activity: [],
      technical: {
        execution_host_id: projection.workspace.executionHostId,
        workspace_key: projection.workspace.workspaceKey,
        run_id: projection.runId,
        revision: projection.revision
      }
    }

    expect(withRuntimeMaestroRunProgress(projection, progress).runProgress).toEqual(progress)
    expect(() =>
      withRuntimeMaestroRunProgress(projection, {
        ...progress,
        technical: { ...progress.technical, workspace_key: 'folder:another' }
      })
    ).toThrow('does not match the projected Run authority')
  })
})
