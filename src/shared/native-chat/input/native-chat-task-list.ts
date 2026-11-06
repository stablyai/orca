import type { NativeChatTaskSeedList } from './native-chat-claude-task-updates'

export type NativeChatTaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type NativeChatTask = {
  content: string
  status: NativeChatTaskStatus
  activeForm?: string
}
export type NativeChatTaskList = { tasks: NativeChatTask[]; explanation?: string }
export type NativeChatTaskChange = {
  kind: 'added' | 'removed' | 'started' | 'completed' | 'pending' | 'cancelled' | 'updated'
  task: NativeChatTask
}
export type NativeChatTaskListTool = 'todowrite' | 'update_plan'

export type NativeChatTaskListEdit = {
  id: string
  content?: string
  status?: NativeChatTaskStatus
  activeForm?: string
}

export type NativeChatTaskListCall =
  | { mode: 'replace'; list: NativeChatTaskSeedList }
  | { mode: 'merge'; edits: NativeChatTaskListEdit[] }

export function nativeChatTaskListTool(name: string): NativeChatTaskListTool | null {
  const canonical = name.trim().toLowerCase().replace(/[_-]/g, '')
  if (canonical === 'todowrite' || canonical === 'writetodos') {
    return 'todowrite'
  }
  return canonical === 'updateplan' ? 'update_plan' : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parsed(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input
  }
  try {
    return JSON.parse(input)
  } catch {
    return null
  }
}

function taskId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : nonemptyString(value)
}

function taskText(item: Record<string, unknown>, tool: NativeChatTaskListTool): string | undefined {
  return tool === 'update_plan'
    ? nonemptyString(item.step)
    : (nonemptyString(item.content) ?? nonemptyString(item.description))
}

/** Grok's schema defaults `merge` to true. Claude, OpenCode, and Gemini omit it and replace. */
function mergesById(name: string, value: Record<string, unknown>): boolean {
  return (
    value.merge === true ||
    (value.merge !== false && name.trim().toLowerCase().replace(/-/g, '') === 'todo_write')
  )
}

function replaceCall(
  value: Record<string, unknown>,
  tool: NativeChatTaskListTool
): NativeChatTaskListCall | null {
  const entries = tool === 'todowrite' ? value.todos : value.plan
  if (!Array.isArray(entries)) {
    return null
  }
  const tasks: NativeChatTaskSeedList['tasks'] = []
  for (const entry of entries) {
    const item = record(entry)
    const content = item ? taskText(item, tool) : undefined
    if (!item || !content) {
      continue
    }
    const id = taskId(item.id)
    const activeForm = tool === 'todowrite' ? nonemptyString(item.activeForm) : undefined
    tasks.push({
      ...(id ? { id } : {}),
      content,
      status: nativeChatTaskStatus(item.status, tool),
      ...(activeForm ? { activeForm } : {})
    })
  }
  if (entries.length > 0 && tasks.length === 0) {
    return null
  }
  const explanation = tool === 'update_plan' ? nonemptyString(value.explanation) : undefined
  return { mode: 'replace', list: { tasks, ...(explanation ? { explanation } : {}) } }
}

function todoEdits(entries: readonly unknown[]): NativeChatTaskListEdit[] {
  const edits: NativeChatTaskListEdit[] = []
  for (const entry of entries) {
    const item = record(entry)
    const id = item ? taskId(item.id) : undefined
    if (!item || !id) {
      continue
    }
    const content = nonemptyString(item.content) ?? nonemptyString(item.description)
    const status =
      typeof item.status === 'string' ? nativeChatTaskStatus(item.status, 'todowrite') : undefined
    const activeForm = nonemptyString(item.activeForm)
    if (!content && !status && !activeForm) {
      continue
    }
    edits.push({
      id,
      ...(content ? { content } : {}),
      ...(status ? { status } : {}),
      ...(activeForm ? { activeForm } : {})
    })
  }
  return edits
}

export function readNativeChatTaskListCall(
  name: string,
  input: unknown
): NativeChatTaskListCall | null {
  const tool = nativeChatTaskListTool(name)
  const value = tool ? record(parsed(input)) : null
  if (!tool || !value) {
    return null
  }
  if (tool === 'update_plan' || !Array.isArray(value.todos) || !mergesById(name, value)) {
    return replaceCall(value, tool)
  }
  const edits = todoEdits(value.todos)
  return edits.length > 0 ? { mode: 'merge', edits } : null
}

export function applyNativeChatTaskListCall(
  previous: NativeChatTaskSeedList | null,
  call: NativeChatTaskListCall
): NativeChatTaskSeedList | null {
  if (call.mode === 'replace') {
    return call.list
  }
  const tasks = previous?.tasks.map((task) => ({ ...task })) ?? []
  let changed = false
  for (const edit of call.edits) {
    const current = tasks.find((task) => task.id === edit.id)
    if (!current) {
      if (!edit.content) {
        continue
      }
      tasks.push({
        id: edit.id,
        content: edit.content,
        status: edit.status ?? 'pending',
        ...(edit.activeForm ? { activeForm: edit.activeForm } : {})
      })
      changed = true
      continue
    }
    if (edit.content && edit.content !== current.content) {
      current.content = edit.content
      changed = true
    }
    if (edit.status && edit.status !== current.status) {
      current.status = edit.status
      changed = true
    }
    if (edit.activeForm && edit.activeForm !== current.activeForm) {
      current.activeForm = edit.activeForm
      changed = true
    }
  }
  if (!changed) {
    return previous
  }
  return { tasks, ...(previous?.explanation ? { explanation: previous.explanation } : {}) }
}

export function normalizeNativeChatTaskList(
  name: string,
  input: unknown
): NativeChatTaskList | null {
  const call = readNativeChatTaskListCall(name, input)
  if (!call || call.mode !== 'replace') {
    return null
  }
  const { tasks, explanation } = call.list
  return {
    tasks: tasks.map(({ id: _id, ...task }) => task),
    ...(explanation ? { explanation } : {})
  }
}

/** Shared task copy for desktop translations and direct mobile rendering. */
export const NATIVE_CHAT_TASK_LIST_COPY = {
  title: 'Tasks',
  completed: 'Completed',
  inProgress: 'In progress',
  pending: 'Pending',
  cancelled: 'Cancelled',
  empty: 'No tasks',
  progress: '{{completed}} of {{total}} tasks completed',
  added: 'Added {{task}}',
  removed: 'Removed {{task}}',
  started: 'Started {{task}}',
  finished: 'Completed {{task}}',
  reset: 'Marked pending: {{task}}',
  updated: 'Updated {{task}}',
  cancelledTask: 'Cancelled {{task}}',
  unchanged: 'Tasks unchanged',
  showAll: 'Full task list'
} as const

export type NativeChatTaskChangeCopyKey =
  | 'added'
  | 'removed'
  | 'started'
  | 'finished'
  | 'reset'
  | 'updated'
  | 'cancelledTask'

/** Which sentence a change reads as, and the task it names. */
export function nativeChatTaskChangeWords(change: NativeChatTaskChange): {
  key: NativeChatTaskChangeCopyKey
  task: string
} {
  switch (change.kind) {
    case 'added':
    case 'removed':
    case 'started':
      return { key: change.kind, task: change.task.content }
    case 'completed':
      return { key: 'finished', task: change.task.content }
    case 'pending':
      return { key: 'reset', task: change.task.content }
    case 'updated':
      return { key: 'updated', task: nativeChatTaskLabel(change.task) }
    case 'cancelled':
      return { key: 'cancelledTask', task: change.task.content }
  }
}

/** Known provider words. Anything else stays pending so a newer status is not dropped or marked done. */
export function nativeChatTaskStatus(
  status: unknown,
  tool?: NativeChatTaskListTool
): NativeChatTaskStatus {
  if (status === 'in_progress' || (tool === 'update_plan' && status === 'inProgress')) {
    return 'in_progress'
  }
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'cancelled' || status === 'canceled') {
    return 'cancelled'
  }
  return 'pending'
}

export function nativeChatCompletedTaskCount(list: NativeChatTaskList): number {
  return list.tasks.filter((task) => task.status === 'completed').length
}

export function nativeChatTaskLabel(task: NativeChatTask): string {
  return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content
}

/** Content plus occurrence is the only identity the providers give these entries. */
export function diffNativeChatTaskLists(
  previous: NativeChatTaskList,
  current: NativeChatTaskList
): NativeChatTaskChange[] {
  const byContent = new Map<string, NativeChatTask[]>()
  for (const task of previous.tasks) {
    const matches = byContent.get(task.content)
    if (matches) {
      matches.push(task)
    } else {
      byContent.set(task.content, [task])
    }
  }
  const occurrences = new Map<string, number>()
  const consumed = new Set<NativeChatTask>()
  const changes: NativeChatTaskChange[] = []
  for (const task of current.tasks) {
    const occurrence = occurrences.get(task.content) ?? 0
    occurrences.set(task.content, occurrence + 1)
    const before = byContent.get(task.content)?.[occurrence]
    if (!before) {
      changes.push({ kind: 'added', task })
      continue
    }
    consumed.add(before)
    if (before.status !== task.status) {
      changes.push({
        kind:
          task.status === 'completed'
            ? 'completed'
            : task.status === 'in_progress'
              ? 'started'
              : task.status === 'cancelled'
                ? 'cancelled'
                : 'pending',
        task
      })
    } else if (before.activeForm !== task.activeForm) {
      changes.push({ kind: 'updated', task })
    }
  }
  for (const task of previous.tasks) {
    if (!consumed.has(task)) {
      changes.push({ kind: 'removed', task })
    }
  }
  return changes
}
