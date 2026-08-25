export type ShortcutWorkspace = {
  id: string
  urlSlug: string
  name: string
  memberId: string
  memberName: string
  mentionName: string
}

export type ShortcutViewer = {
  id: string
  name: string
  mentionName: string
}

export type ShortcutWorkspaceSelection = (string & {}) | 'all'

export type ShortcutConnectionStatus = {
  connected: boolean
  viewer: ShortcutViewer | null
  workspaces?: ShortcutWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: ShortcutWorkspaceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type ShortcutMember = {
  id: string
  name: string
  mentionName?: string
  email?: string | null
  avatarUrl?: string
}

// Shortcut workflow states carry one of three canonical types; anything the
// API adds later degrades to 'started' so boards still bucket sensibly.
export type ShortcutWorkflowStateType = 'unstarted' | 'started' | 'done'

export type ShortcutWorkflowState = {
  id: string
  name: string
  type: ShortcutWorkflowStateType
  position: number
  color?: string
}

export type ShortcutWorkflow = {
  id: string
  name: string
  defaultStateId?: string
  states: ShortcutWorkflowState[]
}

export type ShortcutTeam = {
  id: string
  name: string
  workspaceId?: string
  workspaceName?: string
  defaultWorkflowId?: string
  workflowIds?: string[]
}

export type ShortcutStoryType = 'feature' | 'bug' | 'chore'

export type ShortcutStoryState = {
  id: string
  name: string
  type: ShortcutWorkflowStateType
}

export type ShortcutStory = {
  id: string
  workspaceId?: string
  workspaceName?: string
  title: string
  description?: string
  url: string
  storyType: ShortcutStoryType
  state: ShortcutStoryState
  workflowId?: string
  team?: ShortcutTeam
  epicId?: string
  labels: string[]
  owners: ShortcutMember[]
  requester?: ShortcutMember
  estimate?: number
  archived: boolean
  completed: boolean
  started: boolean
  blocked?: boolean
  updatedAt: string
  createdAt: string
}

export type ShortcutComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  author?: ShortcutMember
}

export type ShortcutStoryUpdate = {
  title?: string
  labels?: string[]
  ownerIds?: string[]
  workflowStateId?: string
  storyType?: ShortcutStoryType
}

export type ShortcutStoryFilter = 'assigned' | 'requested' | 'all' | 'done'

export type ShortcutConnectArgs = {
  apiToken: string
}

export type ShortcutCreateStoryArgs = {
  workspaceId?: string
  teamId?: string
  workflowStateId?: string
  storyType?: ShortcutStoryType
  title: string
  description?: string
}

export type ShortcutCreateStoryResult =
  | { ok: true; id: string; url: string }
  | { ok: false; error: string }

export type ShortcutMutationResult = { ok: true } | { ok: false; error: string }
