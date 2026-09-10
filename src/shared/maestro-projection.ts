import { AgentGraphViewSchema, type AgentGraphView, type MaestroEdgeType } from './maestro-contract'
import {
  AgentGraphProjectionInputSchema,
  displayGraphStatus,
  parseExecutionProfile,
  parseExecutionResource,
  sameProjectedWorkspace,
  workspaceFromIdentity,
  type ProjectedWorkspace
} from './maestro-projection-boundary'
import { reconcileCurrentAttemptNodes, terminalBinding } from './maestro-projection-current-attempt'
import { parseNegotiatedMaestroRunProgress, type MaestroRunProgress } from './maestro-run-progress'
import { MaestroRunProgressV2Schema, type MaestroRunProgressV2 } from './maestro-run-progress-v2'
import {
  MaestroBrowserSurfaceReceiptSchema,
  type MaestroBrowserSurfaceReceipt
} from './maestro-browser-surface'
import {
  describeMaestroProjectionMaterialization,
  type MaestroProjectionMaterialization
} from './maestro-projection-materialization'

export { AgentGraphProjectionInputSchema }
export type { ProjectedWorkspace }
export type AgentGraphProjectionInput = AgentGraphView
export type ProjectedAgentNode = {
  id: string
  type: Exclude<AgentGraphView['nodes'][number]['type'], 'browser-surface'>
  title: string
  summary: string
  rawStatus: string
  status: string
  taskId?: string
  attemptId?: string
  requestedAgent?: string | null
  resolvedAgent?: string | null
  requestedModel?: string | null
  resolvedModel?: string | null
  requestedEffort?: string | null
  resolvedEffort?: string | null
  fallbackReason?: string | null
  role?: string
  terminalId?: string | null
  terminalStatus?: string
  executionHostId: string
  workspaceKey: string
  parentWorkspaceKey?: string
  destinationExecutionHostId?: string
  destinationWorkspaceKey?: string
  portalDirection?: 'to-execution' | 'back-to-home'
  position: { x: number; y: number }
  live: boolean
  browserSurface?: MaestroBrowserSurfaceReceipt
}
export type MaestroProjection = {
  change: string
  runId: string
  repositoryId: string
  coordinator: AgentGraphView['coordinator']
  nodes: ProjectedAgentNode[]
  edges: (Omit<AgentGraphView['edges'][number], 'type'> & {
    type: MaestroEdgeType
  })[]
  revision: number
  cursor: AgentGraphView['cursor']
  source: AgentGraphView['kind']
  workspace: ProjectedWorkspace
  runProgress: MaestroRunProgress
  materialization: MaestroProjectionMaterialization
}
export type RuntimeMaestroProjection = Omit<MaestroProjection, 'runProgress'> & {
  runProgress: MaestroRunProgressV2
}

function projectedEdgeType(type: AgentGraphView['edges'][number]['type']): MaestroEdgeType {
  if (type === 'opens') {
    return 'executes'
  }
  if (type === 'validates' || type === 'captured_as') {
    return 'produces'
  }
  return type
}

export function parseAgentGraphProjection(value: unknown): AgentGraphView {
  return AgentGraphViewSchema.parse(value)
}

export function withRuntimeMaestroRunProgress(
  projection: MaestroProjection,
  value: unknown
): RuntimeMaestroProjection {
  const runProgress = MaestroRunProgressV2Schema.parse(value)
  if (
    runProgress.run.id !== projection.runId ||
    runProgress.technical.execution_host_id !== projection.workspace.executionHostId ||
    runProgress.technical.workspace_key !== projection.workspace.workspaceKey ||
    runProgress.technical.revision !== projection.revision
  ) {
    throw new Error('Runtime Run progress does not match the projected Run authority.')
  }
  return { ...projection, runProgress }
}

function assignNodeWorkspaces(
  view: AgentGraphView,
  orchestrationHome: ProjectedWorkspace,
  executionWorkspace: ProjectedWorkspace
): Map<string, ProjectedWorkspace> {
  const nodeWorkspace = new Map<string, ProjectedWorkspace>()
  const attemptWorkspace = new Map<string, ProjectedWorkspace>()
  for (const node of view.nodes) {
    if (node.type !== 'attempt') {
      continue
    }
    const profile = parseExecutionProfile(node.profile)
    const resource = parseExecutionResource(node.resource)
    const placement = profile?.resolved_placement
    const workspace = {
      executionHostId:
        resource?.execution_host_id ??
        placement?.execution_host_id ??
        executionWorkspace.executionHostId,
      workspaceKey:
        resource?.workspace_key ?? placement?.workspace_key ?? executionWorkspace.workspaceKey
    }
    nodeWorkspace.set(node.id, workspace)
    attemptWorkspace.set(node.attempt_id ?? node.id, workspace)
  }
  for (const node of view.nodes) {
    if (nodeWorkspace.has(node.id)) {
      continue
    }
    const profile = parseExecutionProfile(node.profile)
    const resource = parseExecutionResource(node.resource)
    const linkedAttempt = node.attempt_id ?? resource?.attempt_id
    const placement = profile?.resolved_placement
    const fallback =
      node.type === 'task' || node.type === 'note-reference'
        ? orchestrationHome
        : executionWorkspace
    const inheritedWorkspace = linkedAttempt ? attemptWorkspace.get(linkedAttempt) : undefined
    nodeWorkspace.set(
      node.id,
      inheritedWorkspace ?? {
        executionHostId:
          resource?.execution_host_id ?? placement?.execution_host_id ?? fallback.executionHostId,
        workspaceKey: resource?.workspace_key ?? placement?.workspace_key ?? fallback.workspaceKey
      }
    )
  }
  return nodeWorkspace
}

function browserSurfaceBinding(
  node: AgentGraphView['nodes'][number]
): MaestroBrowserSurfaceReceipt | undefined {
  if (node.type !== 'browser-surface') {
    return undefined
  }
  const parsed = MaestroBrowserSurfaceReceiptSchema.safeParse(node.resource)
  return parsed.success ? parsed.data : undefined
}

export function projectAgentGraphView(
  view: AgentGraphView,
  targetWorkspace = workspaceFromIdentity(view.workspace_scope.execution_workspace)
): MaestroProjection {
  const orchestrationHome = workspaceFromIdentity(view.workspace_scope.orchestration_home)
  const executionWorkspace = workspaceFromIdentity(view.workspace_scope.execution_workspace)
  const singleWorkspace = sameProjectedWorkspace(orchestrationHome, executionWorkspace)
  const {
    view: currentView,
    terminalByAttempt,
    liveTerminalByTask
  } = reconcileCurrentAttemptNodes(view)
  const nodeWorkspaces = assignNodeWorkspaces(currentView, orchestrationHome, executionWorkspace)
  const includedNodes = currentView.nodes.filter((node) => {
    if (singleWorkspace || node.type === 'portal') {
      return true
    }
    const workspace = nodeWorkspaces.get(node.id)
    return workspace ? sameProjectedWorkspace(workspace, targetWorkspace) : false
  })
  const includedIds = new Set(includedNodes.map((node) => node.id))
  const nodes = includedNodes.map((node, index): ProjectedAgentNode => {
    const profile = parseExecutionProfile(node.profile)
    const resource = parseExecutionResource(node.resource)
    const browserSurface = browserSurfaceBinding(node)
    const workspace = nodeWorkspaces.get(node.id) ?? targetWorkspace
    const attemptId = node.attempt_id ?? resource?.attempt_id
    const linkedTerminal =
      (attemptId ? terminalByAttempt.get(attemptId) : undefined) ??
      (node.type === 'task' ? liveTerminalByTask.get(node.task_id ?? node.id) : undefined) ??
      (node.type === 'terminal-receipt' ? terminalBinding(node) : undefined)
    const backlink =
      node.type === 'portal' && sameProjectedWorkspace(targetWorkspace, executionWorkspace)
    const destination = backlink ? orchestrationHome : executionWorkspace
    return {
      id: node.id,
      type: node.type === 'browser-surface' ? 'evidence' : node.type,
      title:
        node.type === 'portal'
          ? backlink
            ? 'Orchestration home'
            : 'Execution workspace'
          : node.summary,
      summary: node.summary,
      rawStatus: node.status,
      status: displayGraphStatus(node.status),
      taskId: node.task_id,
      attemptId,
      requestedAgent: profile?.requested.agent,
      resolvedAgent: profile?.resolved.agent,
      requestedModel: profile?.requested.model,
      resolvedModel: profile?.resolved.model,
      requestedEffort: profile?.requested.effort,
      resolvedEffort: profile?.resolved.effort,
      fallbackReason: profile?.fallback_reason,
      role: profile?.role,
      terminalId: linkedTerminal?.terminalId,
      terminalStatus: linkedTerminal?.terminalStatus,
      executionHostId:
        node.type === 'portal' ? targetWorkspace.executionHostId : workspace.executionHostId,
      workspaceKey: node.type === 'portal' ? targetWorkspace.workspaceKey : workspace.workspaceKey,
      parentWorkspaceKey: node.type === 'portal' ? orchestrationHome.workspaceKey : undefined,
      destinationExecutionHostId: node.type === 'portal' ? destination.executionHostId : undefined,
      destinationWorkspaceKey: node.type === 'portal' ? destination.workspaceKey : undefined,
      portalDirection:
        node.type === 'portal' ? (backlink ? 'back-to-home' : 'to-execution') : undefined,
      position: node.position ?? {
        x: (index % 4) * 264 + 48,
        y: Math.floor(index / 4) * 160 + 48
      },
      live: linkedTerminal?.live ?? false,
      browserSurface
    }
  })
  return {
    change: view.change,
    runId: view.run_id,
    repositoryId: view.workspace_scope.repository_id,
    coordinator: view.coordinator,
    nodes,
    edges: currentView.edges
      .filter((edge) => includedIds.has(edge.source_id) && includedIds.has(edge.target_id))
      .map((edge) => ({ ...edge, type: projectedEdgeType(edge.type) })),
    revision: view.revision,
    cursor: view.cursor,
    source: view.kind,
    workspace: targetWorkspace,
    runProgress: parseNegotiatedMaestroRunProgress(
      view.progress,
      view.run_id === view.workspace_scope.run_id &&
        [orchestrationHome, executionWorkspace].some((workspace) =>
          sameProjectedWorkspace(targetWorkspace, workspace)
        )
        ? {
            runId: view.run_id,
            workspace: targetWorkspace,
            revision: view.revision
          }
        : null
    ),
    materialization: describeMaestroProjectionMaterialization({
      acceptedView: view,
      currentView,
      nodeWorkspaces,
      includedIds,
      targetWorkspace
    })
  }
}

export { applyAgentGraphDelta } from './maestro-graph-delta'
