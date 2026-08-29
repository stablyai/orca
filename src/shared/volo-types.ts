export type VoloPriority = 'low' | 'medium' | 'high' | 'critical'

export type VoloColumnType = 'not_started' | 'in_progress' | 'done' | string

export type VoloViewer = {
  id: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type VoloConnectionStatus = {
  connected: boolean
  viewer: VoloViewer | null
  apiUrl?: string | null
  webUrl?: string | null
  credentialError?: string
  hasSavedLocalCredentials?: boolean
}

export type VoloConnectArgs = {
  apiUrl?: string
  apiToken: string
  webUrl?: string
}

export type VoloConnectResult = { ok: true; viewer: VoloViewer } | { ok: false; error: string }

export type VoloGoogleLoginResult =
  | { ok: true; viewer: VoloViewer; apiToken: string; apiUrl: string }
  | { ok: false; error: string }

export type VoloMutationResult = { ok: true } | { ok: false; error: string }

export type VoloCreateTaskResult =
  | { ok: true; id: string; taskCode: string; url: string }
  | { ok: false; error: string }

export type VoloColumn = {
  id: string
  name: string
  order: number
  color?: string
  type: VoloColumnType
}

export type VoloBoard = {
  id: string
  name: string
  prefix: string
  description?: string
  icon?: string
  columns: VoloColumn[]
}

export type VoloMember = {
  id: string
  userId: string
  name: string
  email?: string | null
  avatarUrl?: string
}

export type VoloTask = {
  id: string
  taskCode: string
  title: string
  description?: string
  url: string
  boardId: string
  boardName?: string
  boardPrefix?: string
  columnId: string
  columnName?: string
  columnType?: VoloColumnType
  columnColor?: string
  priority: VoloPriority
  assigneeId?: string | null
  assigneeName?: string | null
  inKanban: boolean
  dueDate?: string | null
  order: number
  updatedAt: string
  createdAt: string
}

export type VoloTaskFilter = 'assigned' | 'all' | 'done'

export type VoloCreateTaskArgs = {
  boardId: string
  title: string
  columnId: string
  description?: string
  priority?: VoloPriority
  assigneeId?: string | null
}

export type VoloTaskUpdate = {
  title?: string
  description?: string
  priority?: VoloPriority
  assigneeId?: string | null
}

export const VOLO_PRIORITIES: readonly VoloPriority[] = ['low', 'medium', 'high', 'critical']

export function isVoloPriority(value: unknown): value is VoloPriority {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
}

export function isVoloTaskFilter(value: unknown): value is VoloTaskFilter {
  return value === 'assigned' || value === 'all' || value === 'done'
}
