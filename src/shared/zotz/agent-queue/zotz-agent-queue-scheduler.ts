import {
  orderZotzAgentQueue,
  removeZotzAgentTask,
  type ZotzAgentQueue,
  type ZotzQueuedAgentTask
} from './zotz-agent-queue'

/** What the machine can give agents right now: only memory limits them, never a head count. */
export type ZotzAgentCapacity = {
  /** Memory the OS reports as available now, minus what just-admitted agents will take. */
  availableBytes: number
  minFreeBytes: number
}

export type ZotzAgentWaitReason = 'memory'

export type ZotzAgentSchedulingPolicy = {
  /** After waiting this long at the head, nothing may be admitted ahead of it. */
  agingMs: number
  /** After being passed this many times, nothing may be admitted ahead of it. */
  maxBypasses: number
}

export const ZOTZ_AGENT_SCHEDULING_POLICY: ZotzAgentSchedulingPolicy = {
  agingMs: 10 * 60_000,
  maxBypasses: 3
}

export type ZotzAgentSchedulingDecision =
  | { kind: 'empty' }
  | { kind: 'admit'; task: ZotzQueuedAgentTask; backfill: boolean }
  | {
      kind: 'wait'
      head: ZotzQueuedAgentTask
      reason: ZotzAgentWaitReason
      /** The head has aged: memory freed from now on is reserved for it. */
      reserved: boolean
    }

/** Null when the task fits; otherwise the first limit it would break. */
export function zotzAgentTaskWaitReason(
  task: Pick<ZotzQueuedAgentTask, 'estimatedBytes'>,
  capacity: ZotzAgentCapacity
): ZotzAgentWaitReason | null {
  return capacity.availableBytes - task.estimatedBytes < capacity.minFreeBytes ? 'memory' : null
}

function hasAged(
  head: ZotzQueuedAgentTask,
  policy: ZotzAgentSchedulingPolicy,
  now: number
): boolean {
  return now - head.enqueuedAt >= policy.agingMs || head.bypassedCount >= policy.maxBypasses
}

/**
 * Multilevel FIFO with conservative backfill: the head is admitted when it fits; otherwise the
 * first later task that fits may go ahead of it, until the head ages and gets the memory reserved.
 * An admitted task leaves the queue in the returned state; the caller persists it and launches.
 */
export function scheduleNextZotzAgentTask(
  queue: ZotzAgentQueue,
  capacity: ZotzAgentCapacity,
  now: number,
  policy: ZotzAgentSchedulingPolicy = ZOTZ_AGENT_SCHEDULING_POLICY
): { decision: ZotzAgentSchedulingDecision; queue: ZotzAgentQueue } {
  const [head, ...rest] = orderZotzAgentQueue(queue)
  if (!head) {
    return { decision: { kind: 'empty' }, queue }
  }
  const headReason = zotzAgentTaskWaitReason(head, capacity)
  if (headReason === null) {
    return {
      decision: { kind: 'admit', task: head, backfill: false },
      queue: removeZotzAgentTask(queue, head.id)
    }
  }
  const reserved = hasAged(head, policy, now)
  const candidate = reserved
    ? undefined
    : rest.find((task) => zotzAgentTaskWaitReason(task, capacity) === null)
  if (!candidate) {
    return { decision: { kind: 'wait', head, reason: headReason, reserved }, queue }
  }
  const remaining = removeZotzAgentTask(queue, candidate.id)
  return {
    decision: { kind: 'admit', task: candidate, backfill: true },
    queue: {
      ...remaining,
      tasks: remaining.tasks.map((task) =>
        task.id === head.id ? { ...task, bypassedCount: task.bypassedCount + 1 } : task
      )
    }
  }
}
