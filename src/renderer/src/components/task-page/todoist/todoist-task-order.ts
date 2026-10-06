import type { TodoistTask } from '../../../../../shared/todoist-types'

/** Todoist's API priority 4 is the UI's "P1" (urgent); 1 is "P4" (normal). */
export function getTodoistPriorityLabel(priority: TodoistTask['priority']): string {
  return `P${5 - priority}`
}

// Why: mirror Todoist's own list order — urgent first, then soonest due, undated last.
export function sortTodoistTasks(tasks: readonly TodoistTask[]): TodoistTask[] {
  return tasks.toSorted((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority
    }
    const dueA = a.due?.date ?? null
    const dueB = b.due?.date ?? null
    if (dueA !== dueB) {
      return dueA === null ? 1 : dueB === null ? -1 : dueA.localeCompare(dueB)
    }
    return a.content.localeCompare(b.content)
  })
}
