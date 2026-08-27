import { KANBAN_SERVER_URL } from './task-provider-identity'

export { KANBAN_SERVER_URL }

export type KanbanViewer = {
  id: string
  name: string
  level: string
}

// Why: the plaintext metadata carries only display fields; the secret never
// lives here. Exactly these four keys are persisted — no version field.
export type KanbanStoredMetadata = {
  viewerId: string
  viewerName: string
  viewerLevel: string
  updatedAt: string
}

export type KanbanPerson = {
  id: string
  name: string
}

export type KanbanLane = {
  id: string
  name: string
}

export type KanbanComment = {
  id: string
  author: KanbanPerson | null
  text: string
  createdAt: string
}

export type KanbanAttachment = {
  name: string
  url: string
  size: number | null
}

export type KanbanSubtask = {
  id: string
  title: string
  done: boolean
}

export type KanbanConnectionStatus =
  | { connected: false; reason?: 'missing' | 'invalid' | 'decrypt_failed' }
  | { connected: true; viewer: KanbanViewer }

export type KanbanTaskFilter = {
  role: 'executor' | 'observer' | 'creator'
  laneId?: string
  due?: 'overdue' | 'today' | 'week' | 'none'
  urgent?: boolean
  includeDone?: boolean
  query?: string
}

export type KanbanTaskSummary = {
  id: string
  title: string
  laneId: string
  laneName: string
  due: string | null
  urgent: boolean
  repositoryUrls: string[]
  taskVersion: number
  executors: KanbanPerson[]
  observers: KanbanPerson[]
  createdBy: KanbanPerson | null
  url: string
}

export type KanbanTaskDetails = KanbanTaskSummary & {
  result: string
  description: string
  tags: string[]
  source: string | null
  comments: KanbanComment[]
  blockedBy: string[]
  attachments: KanbanAttachment[]
  subtasks: KanbanSubtask[]
}

export type KanbanTaskListResult = {
  tasks: KanbanTaskSummary[]
  lanes: KanbanLane[]
  receivedAt: string
}

export type KanbanRequestErrorCode =
  | 'invalid_token'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'invalid_response'
  | 'timeout'
  | 'network'
  | 'server'

export type KanbanConnectResult =
  | { ok: true; viewer: KanbanViewer }
  | { ok: false; code: KanbanRequestErrorCode; error: string }
