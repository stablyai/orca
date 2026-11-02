// Claude's TaskCreate, TaskUpdate, TaskList, and TaskGet edit one shared task book.
// A later full snapshot from another tool replaces that book.

import {
  nativeChatTaskStatus,
  type NativeChatTask,
  type NativeChatTaskList
} from './native-chat-task-list'

type BookEntry = NativeChatTask & { id?: string }

/** A task row that still knows its provider id, so a later TaskUpdate matches it. */
export type NativeChatTaskSeed = NativeChatTask & { id?: string }
export type NativeChatTaskSeedList = { tasks: NativeChatTaskSeed[]; explanation?: string }

export type NativeChatTaskBook = {
  replace(list: NativeChatTaskSeedList): void
  list(): NativeChatTaskList | null
  seed(): NativeChatTaskSeedList | null
}

export function createNativeChatTaskBook(): NativeChatTaskBook & {
  applyClaude(name: string, input: unknown, output: unknown): void
} {
  const book = new TaskBook()
  return {
    replace: (list) => book.replace(list),
    list: () => book.list(),
    seed: () => book.seed(),
    applyClaude: (name, input, output) => applyClaudeTaskTool(book, name, input, output)
  }
}

class TaskBook {
  private entries: BookEntry[] = []
  private byId = new Map<string, number>()
  private explanation: string | undefined
  private seen = false

  replace(list: NativeChatTaskSeedList): void {
    this.entries = list.tasks.map((task) => ({ ...task }))
    this.explanation = list.explanation
    this.reindex()
    this.seen = true
  }

  list(): NativeChatTaskList | null {
    const seed = this.seed()
    if (!seed) {
      return null
    }
    return {
      tasks: seed.tasks.map(({ id: _id, ...task }) => task),
      ...(seed.explanation ? { explanation: seed.explanation } : {})
    }
  }

  seed(): NativeChatTaskSeedList | null {
    if (!this.seen) {
      return null
    }
    return {
      tasks: this.entries.map((entry) => ({ ...entry })),
      ...(this.explanation ? { explanation: this.explanation } : {})
    }
  }

  get(id: string): NativeChatTask | undefined {
    const index = this.byId.get(id)
    return index === undefined ? undefined : this.entries[index]
  }

  remove(id: string): void {
    const index = this.byId.get(id)
    if (index === undefined) {
      return
    }
    this.entries.splice(index, 1)
    this.reindex()
    this.seen = true
  }

  upsert(id: string, task: NativeChatTask): void {
    const index = this.byId.get(id)
    const entry: BookEntry = { ...task, id }
    if (index === undefined) {
      this.byId.set(id, this.entries.length)
      this.entries.push(entry)
    } else {
      this.entries[index] = entry
    }
    this.explanation = undefined
    this.seen = true
  }

  replaceAll(tasks: BookEntry[]): void {
    this.entries = tasks
    this.explanation = undefined
    this.reindex()
    this.seen = true
  }

  private reindex(): void {
    this.byId.clear()
    this.entries.forEach((entry, index) => {
      if (entry.id) {
        this.byId.set(entry.id, index)
      }
    })
  }
}

function applyClaudeTaskTool(book: TaskBook, name: string, input: unknown, output: unknown): void {
  const tool = name.trim().toLowerCase()
  if (tool !== 'taskcreate' && tool !== 'taskupdate' && tool !== 'tasklist' && tool !== 'taskget') {
    return
  }
  const args = record(parsed(input))
  const body = parsed(output)
  const result = record(body)
  if (tool === 'tasklist') {
    const tasks = Array.isArray(result?.tasks) ? result.tasks : null
    if (!tasks) {
      return
    }
    const entries: BookEntry[] = []
    for (const item of tasks) {
      const task = claudeTask(item)
      if (task) {
        entries.push(task)
      }
    }
    book.replaceAll(entries)
    return
  }
  if (tool === 'taskget') {
    const task = claudeTask(result?.task)
    if (task?.id) {
      book.upsert(task.id, task)
    }
    return
  }
  if (tool === 'taskcreate') {
    const created = record(result?.task)
    const id = nonempty(created?.id) ?? nonempty(result?.id) ?? idInText(output)
    const content =
      nonempty(created?.subject) ??
      nonempty(args?.subject) ??
      nonempty(args?.content) ??
      subjectInText(output)
    if (!id || !content) {
      return
    }
    book.upsert(id, {
      content,
      status: 'pending',
      ...(nonempty(args?.activeForm) ? { activeForm: nonempty(args?.activeForm) } : {})
    })
    return
  }
  if (result?.success === false) {
    return
  }
  const id =
    nonempty(args?.taskId) ??
    nonempty(args?.task_id) ??
    nonempty(result?.taskId) ??
    idInText(output)
  if (!id) {
    return
  }
  const statusWord = nonempty(args?.status)
  if (statusWord === 'deleted') {
    book.remove(id)
    return
  }
  const existing = book.get(id)
  const content = nonempty(args?.subject) ?? existing?.content ?? id
  const activeForm = nonempty(args?.activeForm) ?? existing?.activeForm
  book.upsert(id, {
    content,
    status: statusWord ? nativeChatTaskStatus(statusWord) : (existing?.status ?? 'pending'),
    ...(activeForm ? { activeForm } : {})
  })
}

function claudeTask(value: unknown): BookEntry | null {
  const item = record(value)
  const id = nonempty(item?.id) ?? nonempty(item?.taskId)
  const content = nonempty(item?.subject) ?? nonempty(item?.content)
  if (!id || !content) {
    return null
  }
  const activeForm = nonempty(item?.activeForm)
  return {
    id,
    content,
    status: nativeChatTaskStatus(item?.status),
    ...(activeForm ? { activeForm } : {})
  }
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function idInText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const quoted = /"id"\s*:\s*"([^"]+)"/.exec(value)
  if (quoted?.[1]) {
    return quoted[1]
  }
  // Current Claude Code writes `Task #1 created successfully: …`, not `"id"`.
  return /(?:^|\s)Task #([A-Za-z0-9][\w.-]*)/i.exec(value)?.[1]
}

function subjectInText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const subject = /Task #[A-Za-z0-9][\w.-]* created successfully:\s*(.+)$/i.exec(value.trim())?.[1]
  return subject?.trim() || undefined
}

/** Accept a wire task list. Anything that is not one becomes null so a bad frame cannot invent rows. */
export function readNativeChatTaskSeedList(value: unknown): NativeChatTaskSeedList | null {
  const list = record(value)
  if (!list || !Array.isArray(list.tasks)) {
    return null
  }
  const tasks: NativeChatTaskSeed[] = []
  for (const item of list.tasks) {
    const task = record(item)
    const content = nonempty(task?.content)
    if (!task || !content) {
      continue
    }
    const activeForm = nonempty(task.activeForm)
    const id = nonempty(task.id)
    tasks.push({
      content,
      status: nativeChatTaskStatus(task.status),
      ...(activeForm ? { activeForm } : {}),
      ...(id ? { id } : {})
    })
  }
  if (tasks.length === 0) {
    return null
  }
  const explanation = nonempty(list.explanation)
  return { tasks, ...(explanation ? { explanation } : {}) }
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: null, arrays, and non-objects are rejected above, so the remainder is a string-keyed record.
  return value as Record<string, unknown>
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
