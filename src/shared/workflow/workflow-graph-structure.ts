import type { WorkflowDefinition, WorkflowExecutionDependency } from './workflow-definition-schema'

export type WorkflowExecutionIndex = {
  incoming: Map<string, WorkflowExecutionDependency[]>
  outgoing: Map<string, WorkflowExecutionDependency[]>
}

/** Forward (non-loop) edges only: the graph the scheduler orders by. */
export function indexWorkflowExecution(definition: WorkflowDefinition): WorkflowExecutionIndex {
  const incoming = new Map<string, WorkflowExecutionDependency[]>()
  const outgoing = new Map<string, WorkflowExecutionDependency[]>()
  for (const node of definition.nodes) {
    incoming.set(node.id, [])
    outgoing.set(node.id, [])
  }
  for (const edge of definition.dependencies) {
    if (edge.loop) {
      continue
    }
    incoming.get(edge.target)?.push(edge)
    outgoing.get(edge.source)?.push(edge)
  }
  return { incoming, outgoing }
}

/** Kahn's algorithm; returns the nodes left on a cycle, empty when the forward graph is a DAG. */
export function findForwardCycleNodes(definition: WorkflowDefinition): string[] {
  const index = indexWorkflowExecution(definition)
  const remaining = new Map<string, number>()
  for (const [id, edges] of index.incoming) {
    remaining.set(id, edges.length)
  }
  const queue = [...remaining].filter(([, count]) => count === 0).map(([id]) => id)
  while (queue.length > 0) {
    const id = queue.shift()!
    remaining.delete(id)
    for (const edge of index.outgoing.get(id) ?? []) {
      const count = (remaining.get(edge.target) ?? 0) - 1
      remaining.set(edge.target, count)
      if (count === 0) {
        queue.push(edge.target)
      }
    }
  }
  return [...remaining.keys()]
}

export function forwardReachable(index: WorkflowExecutionIndex, from: string): Set<string> {
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const edge of index.outgoing.get(id) ?? []) {
      if (!seen.has(edge.target)) {
        seen.add(edge.target)
        stack.push(edge.target)
      }
    }
  }
  return seen
}

function backwardReachable(index: WorkflowExecutionIndex, from: string): Set<string> {
  const seen = new Set<string>([from])
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()!
    for (const edge of index.incoming.get(id) ?? []) {
      if (!seen.has(edge.source)) {
        seen.add(edge.source)
        stack.push(edge.source)
      }
    }
  }
  return seen
}

/** Nodes a loop edge re-runs: every node on a forward path from its target to its source. */
export function workflowLoopRegion(
  definition: WorkflowDefinition,
  loopEdge: WorkflowExecutionDependency
): Set<string> {
  const index = indexWorkflowExecution(definition)
  const down = forwardReachable(index, loopEdge.target)
  const up = backwardReachable(index, loopEdge.source)
  return new Set([...down].filter((id) => up.has(id)))
}

/** Forward-topological order; ties keep definition order so layouts and schedules are stable. */
export function workflowTopologicalOrder(definition: WorkflowDefinition): string[] {
  const index = indexWorkflowExecution(definition)
  const remaining = new Map<string, number>()
  for (const [id, edges] of index.incoming) {
    remaining.set(id, edges.length)
  }
  const order: string[] = []
  const ready = definition.nodes.map((node) => node.id).filter((id) => remaining.get(id) === 0)
  while (ready.length > 0) {
    const id = ready.shift()!
    order.push(id)
    for (const edge of index.outgoing.get(id) ?? []) {
      const count = (remaining.get(edge.target) ?? 0) - 1
      remaining.set(edge.target, count)
      if (count === 0) {
        ready.push(edge.target)
      }
    }
  }
  return order
}
