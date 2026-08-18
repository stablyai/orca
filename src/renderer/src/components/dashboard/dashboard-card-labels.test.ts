import { describe, expect, it } from 'vitest'
import { ORCA_DISPATCH_PREAMBLE_PREFIX } from '@/lib/agent-row-primary-text'
import { rowOrchestrationDisplayName, rowTask } from './dashboard-card-labels'

function dispatchPrompt(taskId: string, task: string): string {
  return `${ORCA_DISPATCH_PREAMBLE_PREFIX}\nYour task ID is: ${taskId}\n=== TASK ===\n${task}`
}

describe('rowTask', () => {
  it('keeps matching orchestration identity separate from task text', () => {
    const row = {
      entry: {
        prompt: dispatchPrompt('task-1', 'Raw dispatched task'),
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          displayName: 'Readable worker name',
          taskTitle: 'Readable task title'
        }
      }
    } as Parameters<typeof rowTask>[0]

    expect(rowTask(row)).toBe('Readable task title')
    expect(rowOrchestrationDisplayName(row)).toBe('Readable worker name')
  })

  it('ignores orchestration labels from a different dispatch', () => {
    const row = {
      entry: {
        prompt: dispatchPrompt('task-2', 'Current dispatched task'),
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          displayName: 'Stale worker name',
          taskTitle: 'Stale task title'
        }
      }
    } as Parameters<typeof rowTask>[0]

    expect(rowTask(row)).toBe('Current dispatched task')
    expect(rowOrchestrationDisplayName(row)).toBeUndefined()
  })

  it('ignores sticky orchestration labels for later non-dispatch work', () => {
    const row = {
      entry: {
        prompt: 'Current standalone task',
        orchestration: {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          displayName: 'Stale worker name',
          taskTitle: 'Stale task title'
        }
      }
    } as Parameters<typeof rowTask>[0]

    expect(rowTask(row)).toBe('Current standalone task')
    expect(rowOrchestrationDisplayName(row)).toBeUndefined()
  })
})
