export type ClickUpViewer = {
  id: number
  username: string
  email: string | null
  color?: string
  profilePicture?: string
}

export type ClickUpWorkspace = {
  id: string
  name: string
  color?: string
  avatar?: string
  memberCount?: number
}

// Why: `string & {}` keeps 'all' visible in autocomplete instead of widening
// the whole union to string, matching JiraSiteSelection.
export type ClickUpWorkspaceSelection = (string & {}) | 'all'

export type ClickUpConnectionStatus = {
  connected: boolean
  viewer: ClickUpViewer | null
  workspaces?: ClickUpWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: ClickUpWorkspaceSelection | null
  // Set when the saved token exists but the OS credential store cannot decrypt it.
  credentialError?: string
}

export type ClickUpUser = {
  id: number
  username: string
  email?: string | null
  color?: string
  profilePicture?: string
}

export type ClickUpStatus = {
  name: string
  color: string
  type: string
  orderIndex: number
}

export type ClickUpPriority = {
  id: number
  name: string
  color: string
  orderIndex: number
}

export type ClickUpTag = {
  name: string
  tagFg?: string
  tagBg?: string
}

export type ClickUpList = {
  id: string
  workspaceId: string
  workspaceName?: string
  name: string
  url?: string
  folder?: {
    id: string
    name: string
  }
  space?: {
    id: string
    name: string
  }
  statuses: ClickUpStatus[]
}

export type ClickUpTask = {
  id: string
  customId?: string | null
  workspaceId: string
  workspaceName?: string
  name: string
  description?: string
  url: string
  status: ClickUpStatus
  priority?: ClickUpPriority | null
  assignees: ClickUpUser[]
  creator?: ClickUpUser
  tags: ClickUpTag[]
  list: {
    id: string
    name: string
  }
  folder?: {
    id: string
    name: string
  }
  space?: {
    id: string
    name: string
  }
  parent?: string | null
  subtasks?: ClickUpTaskChild[]
  dueDate?: string | null
  startDate?: string | null
  timeEstimate?: number | null
  points?: number | null
  createdAt: string
  updatedAt: string
  closedAt?: string | null
}

export type ClickUpTaskChild = {
  id: string
  customId?: string | null
  name: string
  url: string
}

export type ClickUpComment = {
  id: string
  body: string
  createdAt: string
  user?: ClickUpUser
}

export type ClickUpTaskFilter = 'assigned' | 'created' | 'all' | 'completed' | 'open'

export type ClickUpTaskUpdate = {
  name?: string
  description?: string
  status?: string
  priority?: number | null
  dueDate?: string | null
  timeEstimate?: number | null
  assigneeIds?: number[]
  tagNames?: string[]
}

export type ClickUpCreateTaskArgs = {
  workspaceId?: string
  listId: string
  name: string
  description?: string
  status?: string
  priority?: number | null
  dueDate?: string
  timeEstimate?: number
  assigneeIds?: number[]
  tagNames?: string[]
  parentTaskId?: string
}

export type ClickUpCreateTaskResult = { ok: true; task: ClickUpTask } | { ok: false; error: string }

export type ClickUpMutationResult = { ok: true } | { ok: false; error: string }

export type ClickUpCommentResult = { ok: true; id: string } | { ok: false; error: string }
