// Why: Asana authenticates with a single Personal Access Token that grants
// access to every workspace the user belongs to. We model each workspace as an
// independent connection entry (keyed by its gid) so multi-workspace selection
// mirrors the Jira multi-site contract the Tasks surface already understands.
export type AsanaWorkspace = {
  id: string
  name: string
  userGid: string
  userName: string
  userEmail: string | null
}

export type AsanaViewer = {
  gid: string
  name: string
  email: string | null
}

export type AsanaWorkspaceSelection = string | 'all'

export type AsanaConnectionStatus = {
  connected: boolean
  viewer: AsanaViewer | null
  workspaces?: AsanaWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: AsanaWorkspaceSelection | null
}

export type AsanaProject = {
  gid: string
  name: string
  workspaceId?: string
  workspaceName?: string
}

export type AsanaUser = {
  gid: string
  name: string
  email?: string | null
  photoUrl?: string | null
}

export type AsanaSection = {
  gid: string
  name: string
}

// Why: Asana has no native status workflow — task state is the `completed`
// boolean, optionally refined by the section the task sits in. We surface both
// so the UI can render a meaningful status label.
export type AsanaTask = {
  gid: string
  workspaceId?: string
  workspaceName?: string
  title: string
  description?: string
  url: string
  completed: boolean
  dueOn?: string | null
  assignee?: AsanaUser
  projects: AsanaProject[]
  section?: string
  createdAt: string
  updatedAt: string
}

export type AsanaComment = {
  gid: string
  text: string
  createdAt: string
  user?: AsanaUser
}

export type AsanaTaskUpdate = {
  title?: string
  notes?: string
  completed?: boolean
  assigneeGid?: string | null
  dueOn?: string | null
}

export type AsanaTaskFilter = 'assigned' | 'all' | 'done'

export type AsanaConnectArgs = {
  apiToken: string
}

export type AsanaCreateTaskArgs = {
  workspaceId?: string
  projectId?: string
  title: string
  notes?: string
  assigneeGid?: string
}

export type AsanaCreateTaskResult =
  | { ok: true; gid: string; url: string }
  | { ok: false; error: string }

export type AsanaMutationResult = { ok: true } | { ok: false; error: string }
