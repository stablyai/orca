import type { SecretAtRestProtection } from '../secure-storage/secret-at-rest-protection'
import type { TaskProviderErrorCode } from '../work-items/task-provider-failure'

// ClickUp calls a Workspace a "team" in its API; Orca keeps the product name.
export type ClickUpWorkspace = {
  id: string
  name: string
  color?: string
}

export type ClickUpUser = {
  id: string
  username: string
  email: string
  avatarUrl?: string
}

export type ClickUpViewer = ClickUpUser

export type ClickUpConnectionStatus = {
  connected: boolean
  viewer: ClickUpViewer | null
  workspaces: ClickUpWorkspace[]
  selectedWorkspaceId: string | null
  // Saved token decryption failures explain an unreadable credential while the connection remains configured.
  credentialError?: string
  // Plaintext means the token is unsealed; older hosts omit protection, which means unknown rather than sealed.
  credentialProtection?: SecretAtRestProtection | null
}

export type ClickUpStatusType = 'open' | 'custom' | 'done' | 'closed'

export type ClickUpStatusOption = {
  name: string
  color: string
  type: ClickUpStatusType
  orderIndex: number
}

export type ClickUpPriority = {
  id: string
  label: string
  color: string
}

export type ClickUpTask = {
  id: string
  customId: string | null
  name: string
  /** Untrusted external markdown. */
  descriptionMarkdown: string
  status: ClickUpStatusOption
  priority: ClickUpPriority | null
  assignees: ClickUpUser[]
  creator: ClickUpUser | null
  tags: string[]
  url: string
  createdAt: string
  updatedAt: string
  dueAt: string | null
  list: { id: string; name: string }
  folder: { id: string; name: string } | null
  spaceId: string
  workspaceId: string
  parentId: string | null
}

export type ClickUpComment = {
  id: string
  /** Untrusted external text. */
  body: string
  createdAt: string
  author: ClickUpUser | null
}

export type ClickUpTaskUpdate = {
  status?: string
  name?: string
}

export type ClickUpTaskScope = 'assigned' | 'all'

export type ClickUpTaskListFilter = {
  scope: ClickUpTaskScope
  includeClosed: boolean
  statuses?: string[]
}

export type ClickUpTaskPage = {
  tasks: ClickUpTask[]
  /** Zero-based index of the next page, or null on the last page. */
  nextPage: number | null
}

export type ClickUpConnectResult =
  | { ok: true; viewer: ClickUpViewer }
  | { ok: false; error: string; errorCode?: TaskProviderErrorCode }

export type ClickUpMutationResult =
  | { ok: true }
  | { ok: false; error: string; errorCode?: TaskProviderErrorCode }

export type ClickUpCommentResult =
  | { ok: true; id: string }
  | { ok: false; error: string; errorCode?: TaskProviderErrorCode }
