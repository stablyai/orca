import { describe, expect, it } from 'vitest'
import {
  createZotzAgentQueue,
  enqueueZotzAgentTask,
  type ZotzAgentQueue,
  type ZotzAgentTaskPriority
} from './zotz-agent-queue'
import { scheduleNextZotzAgentTask, type ZotzAgentCapacity } from './zotz-agent-queue-scheduler'

const GB = 1024 ** 3
const MINUTE = 60_000

// A 16 GB machine with one agent running: 2.4 GB must stay free, so 6 GB available leaves 3.6 GB.
const capacity: ZotzAgentCapacity = {
  availableBytes: 6 * GB,
  minFreeBytes: 2.4 * GB
}

function queueOf(
  tasks: [id: string, priority: ZotzAgentTaskPriority, gb: number][],
  now = 0
): ZotzAgentQueue {
  return tasks.reduce(
    (queue, [id, priority, gb]) =>
      enqueueZotzAgentTask(
        queue,
        { id, agent: 'claude', priority, estimatedBytes: gb * GB, label: id, launch: null },
        now
      ),
    createZotzAgentQueue()
  )
}

describe('scheduleNextZotzAgentTask', () => {
  it('serves manual before remote before automation, and arrival order inside a level', () => {
    let queue = queueOf([
      ['auto-1', 'automation', 1],
      ['remote-1', 'remote', 1],
      ['manual-1', 'manual', 1],
      ['manual-2', 'manual', 1]
    ])
    const admitted: string[] = []
    for (let i = 0; i < 4; i++) {
      const next = scheduleNextZotzAgentTask(queue, capacity, 0)
      if (next.decision.kind === 'admit') {
        admitted.push(next.decision.task.id)
      }
      queue = next.queue
    }
    expect(admitted).toEqual(['manual-1', 'manual-2', 'remote-1', 'auto-1'])
  })

  it('backfills a later task that fits when the head does not, and counts the bypass', () => {
    const { decision, queue } = scheduleNextZotzAgentTask(
      queueOf([
        ['big', 'manual', 5],
        ['small', 'automation', 1.5]
      ]),
      capacity,
      0
    )
    expect(decision).toMatchObject({ kind: 'admit', task: { id: 'small' }, backfill: true })
    expect(queue.tasks).toEqual([expect.objectContaining({ id: 'big', bypassedCount: 1 })])
  })

  it('stops backfilling once the head has waited 10 minutes', () => {
    const { decision, queue } = scheduleNextZotzAgentTask(
      queueOf([
        ['big', 'manual', 5],
        ['small', 'automation', 1.5]
      ]),
      capacity,
      10 * MINUTE
    )
    expect(decision).toMatchObject({
      kind: 'wait',
      head: { id: 'big' },
      reason: 'memory',
      reserved: true
    })
    expect(queue.tasks.map((task) => task.id)).toEqual(['big', 'small'])
  })

  it('stops backfilling once the head has been passed 3 times', () => {
    let queue = queueOf([
      ['big', 'manual', 5],
      ['s1', 'automation', 1],
      ['s2', 'automation', 1],
      ['s3', 'automation', 1],
      ['s4', 'automation', 1]
    ])
    const admitted: string[] = []
    for (let i = 0; i < 4; i++) {
      const next = scheduleNextZotzAgentTask(queue, capacity, MINUTE)
      if (next.decision.kind === 'admit') {
        admitted.push(next.decision.task.id)
      }
      queue = next.queue
    }
    expect(admitted).toEqual(['s1', 's2', 's3'])
    expect(queue.tasks.map((task) => task.id)).toEqual(['big', 's4'])
  })
})
