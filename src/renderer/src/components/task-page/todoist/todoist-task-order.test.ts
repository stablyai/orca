import { describe, expect, it } from 'vitest'
import type { TodoistTask } from '../../../../../shared/todoist-types'
import { getTodoistPriorityLabel, sortTodoistTasks } from './todoist-task-order'

function task(id: string, priority: TodoistTask['priority'], dueDate: string | null): TodoistTask {
  return {
    id,
    content: id,
    description: '',
    projectId: 'p',
    projectName: null,
    priority,
    labels: [],
    due: dueDate ? { date: dueDate, string: null, isRecurring: false } : null,
    url: `https://app.todoist.com/app/task/${id}`,
    addedAt: null,
    completed: false
  }
}

describe('todoist task order', () => {
  it('maps API priority to the Todoist UI label', () => {
    expect(getTodoistPriorityLabel(4)).toBe('P1')
    expect(getTodoistPriorityLabel(1)).toBe('P4')
  })

  it('sorts by priority, then due date with undated tasks last', () => {
    const sorted = sortTodoistTasks([
      task('low-undated', 1, null),
      task('low-late', 1, '2026-10-09'),
      task('urgent', 4, null),
      task('low-soon', 1, '2026-10-02')
    ])
    expect(sorted.map((t) => t.id)).toEqual(['urgent', 'low-soon', 'low-late', 'low-undated'])
  })
})
