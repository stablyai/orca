import { describe, expect, it } from 'vitest'
import {
  createZotzAgentQueue,
  enqueueZotzAgentTask,
  normalizeZotzAgentQueue,
  orderZotzAgentQueue,
  requeueZotzAgentTaskAtFront
} from './zotz-agent-queue'

const task = (id: string) =>
  ({
    id,
    agent: 'codex',
    priority: 'remote',
    estimatedBytes: 1024,
    label: id,
    launch: { worktree: id }
  }) as const

describe('zotz agent queue', () => {
  it('puts a task sent back from review first in its level', () => {
    let queue = createZotzAgentQueue()
    queue = enqueueZotzAgentTask(queue, task('a'), 0)
    queue = enqueueZotzAgentTask(queue, task('b'), 0)
    queue = requeueZotzAgentTaskAtFront(queue, task('c'), 5)
    queue = enqueueZotzAgentTask(queue, task('d'), 6)
    expect(orderZotzAgentQueue(queue).map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('keeps the valid tasks of a damaged file and their order', () => {
    const queue = normalizeZotzAgentQueue({
      version: 1,
      nextSequence: 2,
      tasks: [
        {
          id: 'late',
          agent: 'claude',
          priority: 'manual',
          estimatedBytes: 10,
          enqueuedAt: 2,
          sequence: 7
        },
        {
          id: 'bad-agent',
          agent: 'not-an-agent',
          priority: 'manual',
          estimatedBytes: 10,
          enqueuedAt: 1,
          sequence: 1
        },
        {
          id: 'early',
          agent: 'antigravity',
          priority: 'manual',
          estimatedBytes: 10,
          enqueuedAt: 1,
          sequence: 3,
          launch: { prompt: 'hi' }
        },
        'garbage'
      ]
    })
    expect(orderZotzAgentQueue(queue).map((entry) => entry.id)).toEqual(['early', 'late'])
    expect(queue.tasks.find((entry) => entry.id === 'early')?.launch).toEqual({ prompt: 'hi' })
    expect(queue.nextSequence).toBe(8)
  })
})
