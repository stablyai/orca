// Window ↔ main contract for browsing a sleeping Orca Cloud workspace from the client-side cache
// and for prompts queued to it (wake on message). Keyed by the renderer's workspace id.

export type CloudOfflineChatMessage = {
  itemId: string
  role: 'user' | 'assistant' | 'tool' | 'reasoning' | 'system'
  text: string
  at: number
}

export type CloudOfflineChat = {
  sessionId: string
  /** When this transcript was last read from the VM. */
  at: number
  messages: CloudOfflineChatMessage[]
}

export type CloudOfflineTerminal = {
  handle: string
  title: string | null
  /** Tail of its output (plain text, ANSI removed), oldest first. */
  lines: string[]
  at: number
}

export type CloudOfflineGitChange = { path: string; status: string; area: string }
export type CloudOfflineCommit = {
  id: string
  subject: string
  author: string | null
  at: number | null
}

export type CloudOfflineGit = {
  branch: string | null
  head: string | null
  changes: CloudOfflineGitChange[]
  changeCount: number
  commits: CloudOfflineCommit[]
  at: number
}

export type CloudOfflineSnapshot = {
  workspaceId: string
  /** The VM is asleep (or its wake failed): everything here is read-only. */
  asleep: boolean
  /** Newest capture across the sections; null when nothing was cached yet. */
  capturedAt: number | null
  git: CloudOfflineGit | null
  terminals: CloudOfflineTerminal[]
  chats: CloudOfflineChat[]
}

export type CloudQueuedPromptState = 'queued' | 'sending' | 'delivered' | 'failed'

export type CloudQueuedPrompt = {
  id: string
  workspaceId: string
  sessionId: string
  text: string
  state: CloudQueuedPromptState
  createdAt: number
  updatedAt: number
  /** Why delivery failed (host refusal); absent otherwise. */
  error?: string
}

export type CloudWorkspaceOfflineApi = {
  getSnapshot: (args: { workspaceId: string }) => Promise<CloudOfflineSnapshot | null>
  /** Queue a prompt for an agent chat; wakes the workspace and delivers it once orcad is ready. */
  queuePrompt: (args: {
    workspaceId: string
    sessionId: string
    text: string
  }) => Promise<{ ok: true; prompt: CloudQueuedPrompt } | { ok: false; message: string }>
  listQueuedPrompts: (args: { workspaceId: string }) => Promise<CloudQueuedPrompt[]>
  /** Only while still queued; false once it is being sent. */
  cancelQueuedPrompt: (args: { id: string }) => Promise<boolean>
  editQueuedPrompt: (args: { id: string; text: string }) => Promise<boolean>
  onQueuedPromptsChanged: (callback: (event: { workspaceId: string }) => void) => () => void
}

export const ORCA_CLOUD_OFFLINE_CHANNELS = {
  getSnapshot: 'orcaCloudOffline:getSnapshot',
  queuePrompt: 'orcaCloudOffline:queuePrompt',
  listQueuedPrompts: 'orcaCloudOffline:listQueuedPrompts',
  cancelQueuedPrompt: 'orcaCloudOffline:cancelQueuedPrompt',
  editQueuedPrompt: 'orcaCloudOffline:editQueuedPrompt',
  queuedPromptsChanged: 'orcaCloudOffline:queuedPromptsChanged'
} as const

export const CLOUD_QUEUED_PROMPT_MAX_CHARS = 100_000
