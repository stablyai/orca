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
  /** From the workspace's own sleep snapshot (absent for this computer's cache). */
  agent?: string | null
  title?: string | null
}

export type CloudOfflineTerminal = {
  handle: string
  title: string | null
  /** Tail of its output (plain text, ANSI removed), oldest first. */
  lines: string[]
  at: number
}

type CloudOfflineGitChange = {
  path: string
  status: string
  area: string
  /** Lines, when the workspace's sleep snapshot counted them. */
  added?: number | null
  removed?: number | null
}
type CloudOfflineCommit = {
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
  /** Total lines added/removed across `changes`, when known. */
  added?: number | null
  removed?: number | null
}

export type CloudOfflinePr = {
  number: number
  title: string
  state: string
  /** Always https (checked where it is parsed). */
  url: string
  checksStatus: string | null
  checksSummary: string | null
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
  /** The pull request as of the workspace's last sleep (older builds omit it). */
  pr?: CloudOfflinePr | null
  /**
   * Where the sections came from: this computer's cache, the workspace's own sealed sleep snapshot
   * (Orca Cloud), or both. Older builds omit it (= device).
   */
  source?: 'device' | 'cloud' | 'mixed'
}

/** `unconfirmed`: it may have reached the agent (sent, but the reply never came back). */
type CloudQueuedPromptState = 'queued' | 'sending' | 'delivered' | 'failed' | 'unconfirmed'

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
