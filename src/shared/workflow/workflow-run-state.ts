import type { WorkflowDefinition, WorkflowNode } from './workflow-definition-schema'
import {
  workflowTaskKey,
  type WorkflowEvent,
  type WorkflowEventKind,
  type WorkflowRun,
  type WorkflowTask
} from './workflow-run-types'

export function createWorkflowTask(nodeId: string, iteration: number): WorkflowTask {
  return {
    key: workflowTaskKey(nodeId, iteration),
    nodeId,
    iteration,
    status: 'pending',
    activation: 'normal',
    orcaTaskId: null,
    dispatches: [],
    readyAt: null,
    startedAt: null,
    settledAt: null,
    report: null,
    approval: null,
    prompt: null,
    error: null
  }
}

/** The task for a node's current loop iteration; every node has one from the moment a run starts. */
export function currentWorkflowTask(run: WorkflowRun, nodeId: string): WorkflowTask {
  const iteration = run.iterationByNode[nodeId] ?? 0
  const task = run.tasks[workflowTaskKey(nodeId, iteration)]
  if (!task) {
    throw new Error(`Workflow run ${run.id} has no task for ${nodeId} iteration ${iteration}.`)
  }
  return task
}

export function findWorkflowNode(definition: WorkflowDefinition, nodeId: string): WorkflowNode {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) {
    throw new Error(`Workflow node ${nodeId} does not exist.`)
  }
  return node
}

export function appendWorkflowEvent(
  run: WorkflowRun,
  kind: WorkflowEventKind,
  at: string,
  message: string,
  refs: {
    task?: WorkflowTask
    nodeId?: string
    orcaDispatchId?: string | null
    correlationId?: string | null
    data?: WorkflowEvent['data']
  } = {}
): WorkflowEvent {
  const event: WorkflowEvent = {
    seq: run.nextEventSeq,
    kind,
    at,
    nodeId: refs.task?.nodeId ?? refs.nodeId ?? null,
    taskKey: refs.task?.key ?? null,
    orcaTaskId: refs.task?.orcaTaskId ?? null,
    orcaDispatchId: refs.orcaDispatchId ?? null,
    correlationId: refs.correlationId ?? null,
    message,
    ...(refs.data ? { data: refs.data } : {})
  }
  run.nextEventSeq += 1
  run.events.push(event)
  return event
}

/** Seed one pending task per node and leave every forward edge unresolved. */
export function initializeWorkflowRunState(run: WorkflowRun): void {
  run.tasks = {}
  run.iterationByNode = {}
  run.edgeStates = {}
  run.loopCounts = {}
  for (const node of run.definition.nodes) {
    run.iterationByNode[node.id] = 0
    const task = createWorkflowTask(node.id, 0)
    run.tasks[task.key] = task
  }
  for (const edge of run.definition.dependencies) {
    run.edgeStates[edge.id] = 'pending'
  }
}

/** A fresh run over a frozen copy of the preset's definition. */
export function createWorkflowRunRecord(args: {
  id: string
  presetId: string
  presetName: string
  objective: string
  definition: WorkflowDefinition
  placement: WorkflowRun['placement']
  at: string
}): WorkflowRun {
  const run: WorkflowRun = {
    schemaVersion: 1,
    id: args.id,
    presetId: args.presetId,
    presetName: args.presetName,
    objective: args.objective,
    definition: structuredClone(args.definition),
    placement: args.placement,
    status: 'validating',
    schedulingPaused: false,
    orcaRunId: null,
    coordinatorTerminalHandle: null,
    tasks: {},
    edgeStates: {},
    loopCounts: {},
    iterationByNode: {},
    messages: [],
    events: [],
    nextEventSeq: 0,
    finalOutput: null,
    createdAt: args.at,
    startedAt: null,
    settledAt: null,
    error: null
  }
  initializeWorkflowRunState(run)
  return run
}

export function activeWorkflowAgentCount(run: WorkflowRun): number {
  return run.definition.nodes.filter((node) => {
    const status = currentWorkflowTask(run, node.id).status
    return status === 'dispatched' || status === 'running'
  }).length
}
