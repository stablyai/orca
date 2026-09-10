import { describe, expect, it } from 'vitest'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import {
  projectMaestroAgentTopology,
  type MaestroAgentFormalRelationInput
} from './maestro-agent-topology'

const WORKSPACE = {
  execution_host_id: 'local',
  workspace_key: 'folder:topology-workspace'
}
const LEAF_COORDINATOR = '11111111-1111-4111-8111-111111111111'
const LEAF_IMPLEMENTATION = '22222222-2222-4222-8222-222222222222'
const LEAF_VERIFICATION = '33333333-3333-4333-8333-333333333333'
const LEAF_UNRELATED = '44444444-4444-4444-8444-444444444444'

function terminalSurface(tabId: string, leafId: string, title: string): WorkspaceSurface {
  return {
    id: { ...WORKSPACE, unified_tab_id: tabId },
    content_type: 'terminal',
    entity_id: tabId,
    group_id: 'group-1',
    title,
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: tabId,
      pane_key: leafId,
      session_id: `pty-${tabId}`,
      pty_incarnation: `incarnation-${tabId}`,
      liveness: 'live',
      authority_revision: 1
    }
  }
}

function paneKey(tabId: string, leafId: string): string {
  return `${tabId}:${leafId}`
}

function orchestration(
  overrides: Partial<AgentStatusOrchestrationContext>
): AgentStatusOrchestrationContext {
  return { taskId: 'task-1', dispatchId: 'dispatch-1', ...overrides }
}

describe('Maestro agent topology', () => {
  it('projects native runtime lineage without a formal Run', () => {
    const coordinatorPaneKey = paneKey('terminal-coordinator', LEAF_COORDINATOR)
    const implementationPaneKey = paneKey('terminal-implementation', LEAF_IMPLEMENTATION)
    const verificationPaneKey = paneKey('terminal-verification', LEAF_VERIFICATION)
    const surfaces = {
      coordinator: terminalSurface(
        'terminal-coordinator',
        LEAF_COORDINATOR,
        'Coordinator terminal'
      ),
      implementation: terminalSurface(
        'terminal-implementation',
        LEAF_IMPLEMENTATION,
        'Implement feature'
      ),
      verification: terminalSurface('terminal-verification', LEAF_VERIFICATION, 'Run checks'),
      unrelated: terminalSurface('terminal-unrelated', LEAF_UNRELATED, 'Implement feature')
    }
    const topology = projectMaestroAgentTopology({
      surfaces,
      terminalHandleByPaneKey: {
        [coordinatorPaneKey]: 'handle-coordinator',
        [implementationPaneKey]: 'handle-implementation',
        [verificationPaneKey]: 'handle-verification'
      },
      orchestrationByPaneKey: {
        [implementationPaneKey]: orchestration({
          displayName: 'Implementation',
          taskTitle: 'Ignored task title',
          parentPaneKey: coordinatorPaneKey,
          coordinatorHandle: 'handle-coordinator'
        }),
        [verificationPaneKey]: orchestration({
          taskId: 'task-2',
          dispatchId: 'dispatch-2',
          taskTitle: 'Verification',
          parentPaneKey: implementationPaneKey,
          coordinatorHandle: 'handle-coordinator'
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBe('coordinator')
    expect(topology.nodes).toEqual([
      expect.objectContaining({
        surfaceId: 'coordinator',
        coordinatorSurfaceId: 'coordinator',
        functionLabel: '',
        provenance: 'runtime-lineage'
      }),
      expect.objectContaining({
        surfaceId: 'implementation',
        parentSurfaceId: 'coordinator',
        coordinatorSurfaceId: 'coordinator',
        functionLabel: 'Implementation'
      }),
      expect.objectContaining({
        surfaceId: 'verification',
        parentSurfaceId: 'implementation',
        coordinatorSurfaceId: 'coordinator',
        functionLabel: 'Verification'
      })
    ])
    expect(topology.nodes.some((node) => node.surfaceId === 'unrelated')).toBe(false)
    expect(
      topology.relations.map(({ sourceSurfaceId, targetSurfaceId, kind, provenance }) => ({
        sourceSurfaceId,
        targetSurfaceId,
        kind,
        provenance
      }))
    ).toEqual([
      {
        sourceSurfaceId: 'coordinator',
        targetSurfaceId: 'implementation',
        kind: 'coordinates',
        provenance: 'runtime-lineage'
      },
      {
        sourceSurfaceId: 'coordinator',
        targetSurfaceId: 'verification',
        kind: 'coordinates',
        provenance: 'runtime-lineage'
      },
      {
        sourceSurfaceId: 'coordinator',
        targetSurfaceId: 'implementation',
        kind: 'delegates',
        provenance: 'runtime-lineage'
      },
      {
        sourceSurfaceId: 'implementation',
        targetSurfaceId: 'verification',
        kind: 'delegates',
        provenance: 'runtime-lineage'
      }
    ])
  })

  it('skips generic runtime labels in favor of the formal task function', () => {
    const coordinatorPaneKey = paneKey('terminal-coordinator', LEAF_COORDINATOR)
    const workerPaneKey = paneKey('terminal-worker', LEAF_IMPLEMENTATION)
    const topology = projectMaestroAgentTopology({
      surfaces: {
        coordinator: terminalSurface('terminal-coordinator', LEAF_COORDINATOR, 'Coordinator'),
        worker: terminalSurface('terminal-worker', LEAF_IMPLEMENTATION, 'task_research')
      },
      terminalHandleByPaneKey: {
        [coordinatorPaneKey]: 'handle-coordinator',
        [workerPaneKey]: 'handle-worker'
      },
      orchestrationByPaneKey: {
        [workerPaneKey]: orchestration({
          taskId: 'task-research',
          displayName: 'Agent',
          taskTitle: 'Worker',
          coordinatorHandle: 'handle-coordinator',
          parentTerminalHandle: 'handle-coordinator',
          orchestrationRunId: 'run-1'
        })
      },
      formalProjection: {
        runId: 'run-1',
        nodes: [
          {
            id: 'task-node',
            type: 'task',
            title: 'Research open roles',
            summary: 'Research open roles',
            rawStatus: 'active',
            status: 'active',
            taskId: 'task-research',
            executionHostId: 'local',
            workspaceKey: WORKSPACE.workspace_key,
            position: { x: 0, y: 0 },
            live: true
          },
          {
            id: 'attempt-node',
            type: 'attempt',
            title: 'Agent',
            summary: 'Agent',
            rawStatus: 'active',
            status: 'active',
            taskId: 'task-research',
            terminalId: 'handle-worker',
            executionHostId: 'local',
            workspaceKey: WORKSPACE.workspace_key,
            position: { x: 0, y: 0 },
            live: true
          }
        ],
        edges: []
      }
    })

    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ surfaceId: 'worker', functionLabel: 'Research open roles' })
      ])
    )
  })

  it('resolves a reminted parent only through its stable pane identity', () => {
    const currentCoordinatorPaneKey = paneKey('coordinator-reminted', LEAF_COORDINATOR)
    const staleCoordinatorPaneKey = paneKey('coordinator-original', LEAF_COORDINATOR)
    const workerPaneKey = paneKey('worker', LEAF_IMPLEMENTATION)
    const topology = projectMaestroAgentTopology({
      surfaces: {
        coordinator: terminalSurface('coordinator-reminted', LEAF_COORDINATOR, 'Manual title'),
        worker: terminalSurface('worker', LEAF_IMPLEMENTATION, 'Worker title')
      },
      terminalHandleByPaneKey: {
        [currentCoordinatorPaneKey]: 'handle-coordinator-reminted',
        [workerPaneKey]: 'handle-worker'
      },
      orchestrationByPaneKey: {
        [workerPaneKey]: orchestration({
          taskTitle: 'Authoritative worker function',
          parentPaneKey: staleCoordinatorPaneKey,
          parentTerminalHandle: 'handle-coordinator-original',
          coordinatorHandle: 'handle-coordinator-original',
          orchestrationRunId: 'run-1'
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBe('coordinator')
    expect(topology.nodes).toEqual([
      expect.objectContaining({
        surfaceId: 'coordinator',
        coordinatorSurfaceId: 'coordinator',
        functionLabel: ''
      }),
      expect.objectContaining({
        surfaceId: 'worker',
        parentSurfaceId: 'coordinator',
        coordinatorSurfaceId: 'coordinator',
        functionLabel: 'Authoritative worker function'
      })
    ])
    expect(
      topology.relations.map(({ sourceSurfaceId, targetSurfaceId, kind }) => ({
        sourceSurfaceId,
        targetSurfaceId,
        kind
      }))
    ).toEqual([
      { sourceSurfaceId: 'coordinator', targetSurfaceId: 'worker', kind: 'coordinates' },
      { sourceSurfaceId: 'coordinator', targetSurfaceId: 'worker', kind: 'delegates' }
    ])
  })

  it('does not guess a restored coordinator from unrelated manual surfaces', () => {
    const firstWorkerPaneKey = paneKey('first-worker', LEAF_IMPLEMENTATION)
    const secondWorkerPaneKey = paneKey('second-worker', LEAF_VERIFICATION)
    const topology = projectMaestroAgentTopology({
      surfaces: {
        manual: terminalSurface('manual', LEAF_COORDINATOR, 'Looks like a coordinator'),
        first: terminalSurface('first-worker', LEAF_IMPLEMENTATION, 'First worker'),
        second: terminalSurface('second-worker', LEAF_VERIFICATION, 'Second worker')
      },
      terminalHandleByPaneKey: {
        [firstWorkerPaneKey]: 'handle-first-worker',
        [secondWorkerPaneKey]: 'handle-second-worker'
      },
      orchestrationByPaneKey: {
        [firstWorkerPaneKey]: orchestration({
          displayName: 'First function',
          parentTerminalHandle: 'missing-coordinator-handle',
          coordinatorHandle: 'missing-coordinator-handle',
          orchestrationRunId: 'run-1'
        }),
        [secondWorkerPaneKey]: orchestration({
          taskId: 'task-2',
          dispatchId: 'dispatch-2',
          displayName: 'Second function',
          parentTerminalHandle: 'missing-coordinator-handle',
          coordinatorHandle: 'missing-coordinator-handle',
          orchestrationRunId: 'run-1'
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBeUndefined()
    expect(topology.relations).toEqual([])
    expect(topology.nodes.map((node) => node.surfaceId)).toEqual(['first', 'second'])
  })

  it('keeps parent lineage without promoting an unowned root to coordinator', () => {
    const parentPaneKey = paneKey('parent', LEAF_COORDINATOR)
    const workerPaneKey = paneKey('worker', LEAF_IMPLEMENTATION)
    const topology = projectMaestroAgentTopology({
      surfaces: {
        parent: terminalSurface('parent', LEAF_COORDINATOR, 'Independent terminal'),
        worker: terminalSurface('worker', LEAF_IMPLEMENTATION, 'Worker terminal')
      },
      terminalHandleByPaneKey: {},
      orchestrationByPaneKey: {
        [workerPaneKey]: orchestration({
          taskTitle: 'Owned work',
          parentPaneKey
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBeUndefined()
    expect(topology.relations).toEqual([
      expect.objectContaining({
        sourceSurfaceId: 'parent',
        targetSurfaceId: 'worker',
        kind: 'delegates'
      })
    ])
    expect(topology.nodes).toEqual([
      expect.objectContaining({
        surfaceId: 'worker',
        parentSurfaceId: 'parent',
        coordinatorSurfaceId: undefined,
        functionLabel: 'Owned work'
      })
    ])
  })

  it('keeps formal relation kinds and presentation metadata exact', () => {
    const surfaces = {
      coordinator: terminalSurface(
        'terminal-coordinator',
        LEAF_COORDINATOR,
        'Coordinator terminal'
      ),
      implementation: terminalSurface(
        'terminal-implementation',
        LEAF_IMPLEMENTATION,
        'Implementation terminal'
      ),
      verification: terminalSurface(
        'terminal-verification',
        LEAF_VERIFICATION,
        'Verification terminal'
      ),
      context: terminalSurface('terminal-context', LEAF_UNRELATED, 'Context terminal')
    }
    const implementationPaneKey = paneKey('terminal-implementation', LEAF_IMPLEMENTATION)
    const formalRelations: MaestroAgentFormalRelationInput[] = [
      {
        sourceSurfaceId: 'coordinator',
        targetSurfaceId: 'implementation',
        kind: 'delegates',
        provenance: 'orca-orchestration',
        runId: 'run-1',
        authorityId: 'run-1:spawn',
        sourceFunctionLabel: 'Formal coordinator',
        targetFunctionLabel: 'Formal implementation',
        sourceRole: 'coordinator',
        targetRole: 'worker'
      },
      {
        sourceSurfaceId: 'implementation',
        targetSurfaceId: 'verification',
        kind: 'depends-on',
        provenance: 'orca-orchestration',
        runId: 'run-1',
        authorityId: 'run-1:dependency',
        targetFunctionLabel: 'Formal verification',
        sourceRole: 'worker',
        targetRole: 'worker'
      },
      {
        sourceSurfaceId: 'verification',
        targetSurfaceId: 'coordinator',
        kind: 'reports-to',
        provenance: 'orca-orchestration',
        runId: 'run-1',
        authorityId: 'run-1:report',
        sourceRole: 'worker',
        targetRole: 'coordinator'
      },
      {
        sourceSurfaceId: 'implementation',
        targetSurfaceId: 'context',
        kind: 'context-for',
        provenance: 'orca-orchestration',
        runId: 'run-1',
        authorityId: 'run-1:context',
        targetFunctionLabel: 'Formal context',
        sourceRole: 'worker',
        targetRole: 'worker'
      }
    ]
    const topology = projectMaestroAgentTopology({
      surfaces,
      formalRelations,
      terminalHandleByPaneKey: {},
      orchestrationByPaneKey: {
        [implementationPaneKey]: orchestration({
          displayName: 'Runtime display name',
          taskTitle: 'Runtime task title',
          orchestrationRunId: 'run-1'
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBe('coordinator')
    expect(topology.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surfaceId: 'implementation',
          functionLabel: 'Runtime display name',
          provenance: 'orca-orchestration'
        }),
        expect.objectContaining({
          surfaceId: 'verification',
          functionLabel: 'Formal verification',
          provenance: 'orca-orchestration'
        }),
        expect.objectContaining({
          surfaceId: 'context',
          functionLabel: 'Formal context',
          provenance: 'orca-orchestration'
        })
      ])
    )
    expect(new Set(topology.relations.map((relation) => relation.kind))).toEqual(
      new Set(['coordinates', 'delegates', 'depends-on', 'reports-to', 'context-for'])
    )
    expect(
      topology.relations
        .filter((relation) => relation.kind !== 'coordinates')
        .every((relation) => relation.provenance === 'orca-orchestration')
    ).toBe(true)
  })

  it('omits a coordinator when authoritative roots conflict', () => {
    const rootOnePaneKey = paneKey('root-one', LEAF_COORDINATOR)
    const childOnePaneKey = paneKey('child-one', LEAF_IMPLEMENTATION)
    const rootTwoPaneKey = paneKey('root-two', LEAF_VERIFICATION)
    const childTwoPaneKey = paneKey('child-two', LEAF_UNRELATED)
    const topology = projectMaestroAgentTopology({
      surfaces: {
        'root-one': terminalSurface('root-one', LEAF_COORDINATOR, 'Same title'),
        'child-one': terminalSurface('child-one', LEAF_IMPLEMENTATION, 'Worker'),
        'root-two': terminalSurface('root-two', LEAF_VERIFICATION, 'Same title'),
        'child-two': terminalSurface('child-two', LEAF_UNRELATED, 'Worker')
      },
      terminalHandleByPaneKey: {},
      orchestrationByPaneKey: {
        [childOnePaneKey]: orchestration({ parentPaneKey: rootOnePaneKey }),
        [childTwoPaneKey]: orchestration({
          taskId: 'task-2',
          dispatchId: 'dispatch-2',
          parentPaneKey: rootTwoPaneKey
        })
      }
    })

    expect(topology.coordinatorSurfaceId).toBeUndefined()
    expect(topology.relations.filter((relation) => relation.kind === 'coordinates')).toEqual([])
    expect(topology.relations.filter((relation) => relation.kind === 'delegates')).toHaveLength(2)
    expect(topology.nodes.every((node) => node.coordinatorSurfaceId === undefined)).toBe(true)
  })

  it('fails closed on conflicting formal receipts and duplicate handle joins', () => {
    const firstPaneKey = paneKey('first', LEAF_COORDINATOR)
    const secondPaneKey = paneKey('second', LEAF_IMPLEMENTATION)
    const childPaneKey = paneKey('child', LEAF_VERIFICATION)
    const relation: MaestroAgentFormalRelationInput = {
      sourceSurfaceId: 'first',
      targetSurfaceId: 'child',
      kind: 'delegates',
      provenance: 'orca-orchestration',
      runId: 'run-1',
      authorityId: 'run-1:conflict',
      sourceRole: 'coordinator',
      targetRole: 'worker'
    }
    const topology = projectMaestroAgentTopology({
      surfaces: {
        first: terminalSurface('first', LEAF_COORDINATOR, 'Coordinator'),
        second: terminalSurface('second', LEAF_IMPLEMENTATION, 'Coordinator'),
        child: terminalSurface('child', LEAF_VERIFICATION, 'Worker')
      },
      terminalHandleByPaneKey: {
        [firstPaneKey]: 'duplicate-handle',
        [secondPaneKey]: 'duplicate-handle'
      },
      orchestrationByPaneKey: {
        [childPaneKey]: orchestration({ coordinatorHandle: 'duplicate-handle' })
      },
      formalRelations: [relation, { ...relation, sourceSurfaceId: 'second' }]
    })

    expect(topology.coordinatorSurfaceId).toBeUndefined()
    expect(topology.relations).toEqual([])
    expect(topology.nodes).toEqual([
      expect.objectContaining({
        surfaceId: 'child',
        parentSurfaceId: undefined,
        coordinatorSurfaceId: undefined,
        functionLabel: ''
      })
    ])
  })
})
