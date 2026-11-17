import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../agent-launch/catalog/tui-agent-config'

/** Who asked for the agent; a lower rank is served first. */
export const ZOTZ_AGENT_TASK_PRIORITIES = ['manual', 'remote', 'automation'] as const
export type ZotzAgentTaskPriority = (typeof ZOTZ_AGENT_TASK_PRIORITIES)[number]

export type ZotzQueuedAgentTask = {
  id: string
  agent: TuiAgent
  priority: ZotzAgentTaskPriority
  /** What the scheduler reserves for it: the ledger's p90 or the default reserve. */
  estimatedBytes: number
  enqueuedAt: number
  /** FIFO order inside its priority level; a requeue at the front goes below every other. */
  sequence: number
  /** Times a later task was admitted ahead of it while it was the head (backfill). */
  bypassedCount: number
  label: string
  /** Opaque launch request kept so a queued task survives a restart; the launcher validates it. */
  launch: unknown
}

/** The backlog: every agent launch that has not been admitted yet. Persisted as JSON. */
export type ZotzAgentQueue = {
  version: 1
  nextSequence: number
  tasks: ZotzQueuedAgentTask[]
}

export type ZotzAgentTaskInput = Pick<
  ZotzQueuedAgentTask,
  'id' | 'agent' | 'priority' | 'estimatedBytes' | 'label' | 'launch'
>

export function createZotzAgentQueue(): ZotzAgentQueue {
  return { version: 1, nextSequence: 0, tasks: [] }
}

function priorityRank(priority: ZotzAgentTaskPriority): number {
  return ZOTZ_AGENT_TASK_PRIORITIES.indexOf(priority)
}

function withoutTask(queue: ZotzAgentQueue, id: string): ZotzQueuedAgentTask[] {
  return queue.tasks.filter((task) => task.id !== id)
}

/** Adds a task at the back of its priority level; an existing task with the same id is replaced. */
export function enqueueZotzAgentTask(
  queue: ZotzAgentQueue,
  input: ZotzAgentTaskInput,
  now: number
): ZotzAgentQueue {
  const task: ZotzQueuedAgentTask = {
    ...input,
    enqueuedAt: now,
    sequence: queue.nextSequence,
    bypassedCount: 0
  }
  return {
    ...queue,
    nextSequence: queue.nextSequence + 1,
    tasks: [...withoutTask(queue, input.id), task]
  }
}

/** Puts a task first in its priority level, e.g. sent back from review or a launch that failed. */
export function requeueZotzAgentTaskAtFront(
  queue: ZotzAgentQueue,
  input: ZotzAgentTaskInput,
  now: number
): ZotzAgentQueue {
  const others = withoutTask(queue, input.id)
  const levelSequences = others
    .filter((task) => task.priority === input.priority)
    .map((task) => task.sequence)
  const sequence = levelSequences.length > 0 ? Math.min(...levelSequences) - 1 : queue.nextSequence
  const task: ZotzQueuedAgentTask = { ...input, enqueuedAt: now, sequence, bypassedCount: 0 }
  return {
    ...queue,
    nextSequence: Math.max(queue.nextSequence, sequence + 1),
    tasks: [...others, task]
  }
}

export function removeZotzAgentTask(queue: ZotzAgentQueue, id: string): ZotzAgentQueue {
  return { ...queue, tasks: withoutTask(queue, id) }
}

/** Service order: by priority level, then by arrival inside the level. Index 0 is the head. */
export function orderZotzAgentQueue(queue: ZotzAgentQueue): ZotzQueuedAgentTask[] {
  return [...queue.tasks].sort(
    (left, right) =>
      priorityRank(left.priority) - priorityRank(right.priority) || left.sequence - right.sequence
  )
}

function isZotzAgentTaskPriority(value: unknown): value is ZotzAgentTaskPriority {
  return ZOTZ_AGENT_TASK_PRIORITIES.some((priority) => priority === value)
}

function normalizeTask(value: unknown): ZotzQueuedAgentTask | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record: Record<string, unknown> = { ...value }
  const { id, agent, priority, estimatedBytes, enqueuedAt, sequence, bypassedCount, label } = record
  if (
    typeof id !== 'string' ||
    id === '' ||
    !isTuiAgent(agent) ||
    !isZotzAgentTaskPriority(priority) ||
    typeof estimatedBytes !== 'number' ||
    !(estimatedBytes > 0) ||
    typeof enqueuedAt !== 'number' ||
    !Number.isFinite(enqueuedAt) ||
    typeof sequence !== 'number' ||
    !Number.isSafeInteger(sequence)
  ) {
    return null
  }
  return {
    id,
    agent,
    priority,
    estimatedBytes,
    enqueuedAt,
    sequence,
    bypassedCount:
      typeof bypassedCount === 'number' && Number.isSafeInteger(bypassedCount) && bypassedCount > 0
        ? bypassedCount
        : 0,
    label: typeof label === 'string' ? label : '',
    launch: record.launch
  }
}

/** Reads a persisted queue, dropping malformed tasks instead of losing the whole backlog. */
export function normalizeZotzAgentQueue(value: unknown): ZotzAgentQueue {
  if (typeof value !== 'object' || value === null || !('tasks' in value)) {
    return createZotzAgentQueue()
  }
  const rawTasks = Array.isArray(value.tasks) ? value.tasks : []
  const tasks: ZotzQueuedAgentTask[] = []
  const seen = new Set<string>()
  for (const raw of rawTasks) {
    const task = normalizeTask(raw)
    if (task && !seen.has(task.id)) {
      seen.add(task.id)
      tasks.push(task)
    }
  }
  const highest = tasks.reduce((max, task) => Math.max(max, task.sequence), -1)
  const stored = 'nextSequence' in value ? value.nextSequence : undefined
  const nextSequence =
    typeof stored === 'number' && Number.isSafeInteger(stored) && stored > highest
      ? stored
      : highest + 1
  return { version: 1, nextSequence, tasks }
}
