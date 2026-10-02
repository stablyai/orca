export type TodoistViewer = {
  id: string
  fullName: string
  email: string
}

export type TodoistConnectionStatus = {
  connected: boolean
  viewer: TodoistViewer | null
  /** Set when a token is saved but unreadable (e.g. keychain denied). */
  error?: string
}

export type TodoistProject = {
  id: string
  name: string
}

export type TodoistTask = {
  id: string
  content: string
  description: string
  projectId: string
  projectName: string | null
  /** Todoist API priority: 1 (normal) .. 4 (urgent). */
  priority: 1 | 2 | 3 | 4
  labels: string[]
  due: { date: string; string: string | null; isRecurring: boolean } | null
  url: string
  addedAt: string | null
  completed: boolean
}

export type TodoistComment = {
  id: string
  content: string
  postedAt: string | null
}

export type TodoistConnectResult =
  | { ok: true; viewer: TodoistViewer }
  | { ok: false; error: string }

export type TodoistMutationResult = { ok: true } | { ok: false; error: string }

export function todoistTaskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(id)}`
}
