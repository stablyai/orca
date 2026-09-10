import type { AgentGraphView } from './maestro-contract'
import { parseExecutionResource, terminalReceiptIsLive } from './maestro-projection-boundary'

export type TerminalBinding = {
  terminalId: string | null
  terminalStatus: string
  live: boolean
}

export function terminalBinding(node: AgentGraphView['nodes'][number]): TerminalBinding {
  const resource = parseExecutionResource(node.resource)
  const terminalId = resource?.terminal_id ?? null
  return {
    terminalId,
    terminalStatus: resource?.terminal_status ?? node.status,
    live: terminalId !== null && terminalReceiptIsLive(node.status, resource)
  }
}

function preferLiveTerminal(
  current: TerminalBinding | undefined,
  candidate: TerminalBinding
): TerminalBinding {
  return !current || (!current.live && candidate.live) ? candidate : current
}

function mapNodeTerminals(view: AgentGraphView): {
  terminalByAttempt: Map<string, TerminalBinding>
  liveTerminalByTask: Map<string, TerminalBinding>
} {
  const terminalByAttempt = new Map<string, TerminalBinding>()
  const liveTerminalByTask = new Map<string, TerminalBinding>()
  const nodesById = new Map(view.nodes.map((node) => [node.id, node]))
  for (const node of view.nodes) {
    if (node.type !== 'terminal-receipt') {
      continue
    }
    const binding = terminalBinding(node)
    const attemptId = node.attempt_id ?? parseExecutionResource(node.resource)?.attempt_id
    if (attemptId) {
      terminalByAttempt.set(
        attemptId,
        preferLiveTerminal(terminalByAttempt.get(attemptId), binding)
      )
    }
    if (node.task_id && binding.live) {
      liveTerminalByTask.set(node.task_id, binding)
    }
  }
  for (const edge of view.edges) {
    if (edge.type !== 'executes') {
      continue
    }
    const source = nodesById.get(edge.source_id)
    const target = nodesById.get(edge.target_id)
    const attempt = source?.type === 'attempt' ? source : target?.type === 'attempt' ? target : null
    const terminal =
      source?.type === 'terminal-receipt'
        ? source
        : target?.type === 'terminal-receipt'
          ? target
          : null
    if (attempt && terminal) {
      const attemptId = attempt.attempt_id ?? attempt.id
      terminalByAttempt.set(
        attemptId,
        preferLiveTerminal(terminalByAttempt.get(attemptId), terminalBinding(terminal))
      )
    }
  }
  for (const edge of view.edges) {
    if (edge.type !== 'reports_to') {
      continue
    }
    const source = nodesById.get(edge.source_id)
    const target = nodesById.get(edge.target_id)
    const attempt = source?.type === 'attempt' ? source : target?.type === 'attempt' ? target : null
    const task = source?.type === 'task' ? source : target?.type === 'task' ? target : null
    const binding = attempt ? terminalByAttempt.get(attempt.attempt_id ?? attempt.id) : undefined
    const taskId = task?.task_id ?? task?.id
    if (taskId && binding?.live) {
      liveTerminalByTask.set(taskId, binding)
    }
  }
  return { terminalByAttempt, liveTerminalByTask }
}

const SUCCESSFUL_ATTEMPT_STATUSES = new Set(['approved', 'completed', 'finished', 'succeeded'])
const FAILED_ATTEMPT_STATUSES = new Set(['circuit_broken', 'failed'])

function selectCurrentAttemptNodeIds(
  view: AgentGraphView,
  terminalByAttempt: ReadonlyMap<string, TerminalBinding>
): Set<string> {
  const taskById = new Map(
    view.nodes.flatMap((node) =>
      node.type === 'task' ? [[node.task_id ?? node.id, node] as const] : []
    )
  )
  const attemptsByTask = new Map<string, AgentGraphView['nodes'][number][]>()
  for (const node of view.nodes) {
    if (node.type !== 'attempt' || !node.task_id) {
      continue
    }
    attemptsByTask.set(node.task_id, [...(attemptsByTask.get(node.task_id) ?? []), node])
  }

  return new Set(
    [...attemptsByTask.entries()].flatMap(([taskId, attempts]) => {
      const taskStatus = taskById.get(taskId)?.status.toLowerCase()
      const succeeded = taskStatus && SUCCESSFUL_ATTEMPT_STATUSES.has(taskStatus)
      const hasSuccessfulAttempt = attempts.some((attempt) =>
        SUCCESSFUL_ATTEMPT_STATUSES.has(attempt.status.toLowerCase())
      )
      return attempts
        .filter(
          (attempt) =>
            !succeeded ||
            !hasSuccessfulAttempt ||
            !FAILED_ATTEMPT_STATUSES.has(attempt.status.toLowerCase()) ||
            terminalByAttempt.get(attempt.attempt_id ?? attempt.id)?.live
        )
        .map((attempt) => attempt.id)
    })
  )
}

function filterSupersededAttemptNodes(
  view: AgentGraphView,
  terminalByAttempt: ReadonlyMap<string, TerminalBinding>
): AgentGraphView['nodes'] {
  const nodesById = new Map(view.nodes.map((node) => [node.id, node] as const))
  const selectedAttemptNodeIds = selectCurrentAttemptNodeIds(view, terminalByAttempt)
  const selectedAttemptReferences = new Set(
    view.nodes.flatMap((node) =>
      node.type === 'attempt' && (!node.task_id || selectedAttemptNodeIds.has(node.id))
        ? [node.id, node.attempt_id].filter((value): value is string => Boolean(value))
        : []
    )
  )
  const attemptByTerminalNode = new Map(
    view.edges.flatMap((edge) => {
      if (edge.type !== 'executes') {
        return []
      }
      const source = nodesById.get(edge.source_id)
      const target = nodesById.get(edge.target_id)
      const attempt =
        source?.type === 'attempt' ? source : target?.type === 'attempt' ? target : null
      const terminal =
        source?.type === 'terminal-receipt'
          ? source
          : target?.type === 'terminal-receipt'
            ? target
            : null
      return attempt && terminal ? [[terminal.id, attempt.attempt_id ?? attempt.id] as const] : []
    })
  )

  return view.nodes.filter((node) => {
    if (node.type === 'attempt') {
      return !node.task_id || selectedAttemptNodeIds.has(node.id)
    }
    if (node.type !== 'terminal-receipt' && node.type !== 'browser-surface') {
      return true
    }
    const resource = parseExecutionResource(node.resource)
    if (
      (node.type === 'terminal-receipt' &&
        resource?.liveness !== 'exited' &&
        !['exited', 'released', 'archived', 'superseded'].includes(node.status)) ||
      (node.type === 'browser-surface' && node.status !== 'released')
    ) {
      return true
    }
    const attemptReference =
      node.attempt_id ??
      parseExecutionResource(node.resource)?.attempt_id ??
      attemptByTerminalNode.get(node.id)
    const knownAttempt = view.nodes.some(
      (candidate) =>
        candidate.type === 'attempt' &&
        (candidate.id === attemptReference || candidate.attempt_id === attemptReference)
    )
    return !knownAttempt || !attemptReference || selectedAttemptReferences.has(attemptReference)
  })
}

export function reconcileCurrentAttemptNodes(view: AgentGraphView): {
  view: AgentGraphView
  terminalByAttempt: Map<string, TerminalBinding>
  liveTerminalByTask: Map<string, TerminalBinding>
} {
  const allTerminalBindings = mapNodeTerminals(view).terminalByAttempt
  const nodes = filterSupersededAttemptNodes(view, allTerminalBindings)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const currentView = {
    ...view,
    nodes,
    edges: view.edges.filter((edge) => nodeIds.has(edge.source_id) && nodeIds.has(edge.target_id))
  }
  return { view: currentView, ...mapNodeTerminals(currentView) }
}
