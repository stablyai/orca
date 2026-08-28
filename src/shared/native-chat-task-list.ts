import { pairToolBlocks, type NativeChatToolPair } from './native-chat-tool-fold'
import type { NativeChatBlock, NativeChatMessage } from './native-chat-types'

export const NATIVE_CHAT_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type NativeChatTaskStatus = (typeof NATIVE_CHAT_TASK_STATUSES)[number]

export type NativeChatTask = {
  id: string
  subject: string
  activeForm?: string
  status: NativeChatTaskStatus
}

const TASK_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])

export function isNativeChatTaskToolName(name: string): boolean {
  return TASK_TOOL_NAMES.has(name)
}

/** Rebuild Claude's latest task snapshot from its transcript tool stream. */
export function deriveNativeChatTasks(messages: readonly NativeChatMessage[]): NativeChatTask[] {
  // Why: current Claude sessions emit task mutations rather than a full checklist;
  // replaying them keeps native chat aligned with the terminal's latest state.
  const blocks = messages.flatMap((message) => message.blocks)
  const tasks = new Map<string, NativeChatTask>()

  for (const [index, pair] of pairToolBlocks(blocks).entries()) {
    applyTaskToolPair(tasks, pair, index)
  }

  return [...tasks.values()]
}

/** Remove task-management calls once their richer list is visible. */
export function withoutNativeChatTaskToolBlocks(
  blocks: readonly NativeChatBlock[]
): NativeChatBlock[] {
  const output: NativeChatBlock[] = []
  const taskCalls: boolean[] = []
  let resultOrdinal = 0

  for (const block of blocks) {
    if (block.type === 'tool-call') {
      const isTaskCall = isNativeChatTaskToolName(block.name)
      taskCalls.push(isTaskCall)
      if (!isTaskCall) {
        output.push(block)
      }
      continue
    }
    if (block.type === 'tool-result') {
      const belongsToTaskCall = taskCalls[resultOrdinal]
      if (belongsToTaskCall !== undefined) {
        resultOrdinal += 1
      }
      if (belongsToTaskCall !== true) {
        output.push(block)
      }
      continue
    }
    output.push(block)
  }

  return output
}

function applyTaskToolPair(
  tasks: Map<string, NativeChatTask>,
  pair: NativeChatToolPair,
  pairIndex: number
): void {
  const call = pair.call
  if (!call || !isNativeChatTaskToolName(call.name) || pair.result?.isError === true) {
    return
  }

  if (call.name === 'TodoWrite') {
    const snapshot = legacyTodoSnapshot(call.input)
    if (snapshot) {
      replaceTasks(tasks, snapshot)
    }
    return
  }

  if (call.name === 'TaskList') {
    const snapshot = taskSnapshotFromOutput(pair.result?.output)
    if (snapshot) {
      replaceTasks(tasks, snapshot)
    }
    return
  }

  if (call.name === 'TaskGet') {
    const task = taskFromToolOutput(pair.result?.output)
    if (task) {
      upsertTask(tasks, task)
    }
    return
  }

  if (call.name === 'TaskCreate') {
    applyTaskCreate(tasks, call.input, pair.result?.output, pairIndex)
    return
  }

  applyTaskUpdate(tasks, call.input, pair.result?.output)
}

function applyTaskCreate(
  tasks: Map<string, NativeChatTask>,
  input: unknown,
  output: string | undefined,
  pairIndex: number
): void {
  const inputRecord = recordOf(input)
  const subject = stringOf(inputRecord?.subject)
  if (!subject) {
    return
  }
  const resultTask = taskFromToolOutput(output)
  const id = resultTask?.id ?? taskIdFromOutput(output) ?? `pending:${pairIndex}:${subject}`
  upsertTask(tasks, {
    id,
    subject: resultTask?.subject ?? subject,
    status: resultTask?.status ?? 'pending',
    ...optionalActiveForm(resultTask?.activeForm ?? activeFormOf(inputRecord))
  })
}

function applyTaskUpdate(
  tasks: Map<string, NativeChatTask>,
  input: unknown,
  output: string | undefined
): void {
  const inputRecord = recordOf(input)
  const resultTask = taskFromToolOutput(output)
  const id = taskIdOf(inputRecord) ?? resultTask?.id
  if (!id) {
    return
  }
  if (inputRecord?.status === 'deleted') {
    tasks.delete(id)
    return
  }

  const current = tasks.get(id)
  const subject = stringOf(inputRecord?.subject) ?? resultTask?.subject ?? current?.subject
  if (!subject) {
    return
  }
  const status =
    taskStatusOf(inputRecord?.status) ?? resultTask?.status ?? current?.status ?? 'pending'
  upsertTask(tasks, {
    id,
    subject,
    status,
    ...optionalActiveForm(
      activeFormOf(inputRecord) ?? resultTask?.activeForm ?? current?.activeForm
    )
  })
}

function replaceTasks(tasks: Map<string, NativeChatTask>, snapshot: NativeChatTask[]): void {
  tasks.clear()
  for (const task of snapshot) {
    tasks.set(task.id, task)
  }
}

function upsertTask(tasks: Map<string, NativeChatTask>, task: NativeChatTask): void {
  const current = tasks.get(task.id)
  tasks.set(task.id, current ? { ...current, ...task } : task)
}

function legacyTodoSnapshot(input: unknown): NativeChatTask[] | null {
  const todos = recordOf(input)?.todos
  if (!Array.isArray(todos)) {
    return null
  }
  const snapshot: NativeChatTask[] = []
  for (const [index, value] of todos.entries()) {
    const record = recordOf(value)
    const subject = stringOf(record?.content) ?? stringOf(record?.subject)
    if (!subject) {
      continue
    }
    snapshot.push({
      id: stringOf(record?.id) ?? `todo:${index}:${subject}`,
      subject,
      status: taskStatusOf(record?.status) ?? 'pending',
      ...optionalActiveForm(activeFormOf(record))
    })
  }
  return snapshot
}

function taskSnapshotFromOutput(output: string | undefined): NativeChatTask[] | null {
  if (!output) {
    return null
  }
  const parsed = parseToolOutput(output)
  const record = recordOf(parsed)
  const values = Array.isArray(parsed) ? parsed : record?.tasks
  if (Array.isArray(values)) {
    const tasks = values
      .map((value, index) => taskFromUnknown(value, `task:${index}`))
      .filter((task): task is NativeChatTask => task !== null)
    return tasks
  }
  return taskSnapshotFromText(output)
}

function taskSnapshotFromText(output: string): NativeChatTask[] | null {
  if (/^no tasks(?: found)?[.!]?$/i.test(output.trim())) {
    return []
  }
  const tasks: NativeChatTask[] = []
  for (const line of output.split('\n')) {
    const match = line
      .trim()
      .match(/^#?([^\s.]+)[.)]?\s+\[(pending|in_progress|completed)\]\s+(.+)$/)
    if (!match) {
      continue
    }
    tasks.push({ id: match[1]!, status: match[2] as NativeChatTaskStatus, subject: match[3]! })
  }
  return tasks.length > 0 ? tasks : null
}

function taskFromToolOutput(output: string | undefined): NativeChatTask | null {
  if (!output) {
    return null
  }
  const parsed = parseToolOutput(output)
  const record = recordOf(parsed)
  return taskFromUnknown(record?.task ?? parsed)
}

function taskFromUnknown(value: unknown, fallbackId?: string): NativeChatTask | null {
  const record = recordOf(value)
  if (!record) {
    return null
  }
  const subject = stringOf(record.subject) ?? stringOf(record.content)
  const id = taskIdOf(record) ?? fallbackId
  if (!subject || !id) {
    return null
  }
  return {
    id,
    subject,
    status: taskStatusOf(record.status) ?? 'pending',
    ...optionalActiveForm(activeFormOf(record))
  }
}

function taskIdFromOutput(output: string | undefined): string | null {
  if (!output) {
    return null
  }
  return (
    output.match(/\btask\s+#([^\s,:]+)/i)?.[1] ??
    output.match(/\btask(?:\s+id)?\s*[:=]\s*([^\s,]+)/i)?.[1] ??
    null
  )
}

function parseToolOutput(output: string): unknown {
  const trimmed = output.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed
  try {
    return JSON.parse(fenced) as unknown
  } catch {
    return null
  }
}

function taskStatusOf(value: unknown): NativeChatTaskStatus | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null
}

function activeFormOf(record: Record<string, unknown> | null | undefined): string | undefined {
  return stringOf(record?.activeForm) ?? stringOf(record?.active_form) ?? undefined
}

function taskIdOf(record: Record<string, unknown> | null | undefined): string | null {
  // Why: Claude streams repaired task inputs with either camelCase or snake_case keys.
  return stringOf(record?.taskId) ?? stringOf(record?.task_id) ?? stringOf(record?.id)
}

function optionalActiveForm(activeForm: string | undefined): { activeForm?: string } {
  return activeForm ? { activeForm } : {}
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringOf(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || null
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}
