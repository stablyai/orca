import {
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'

export type WorkspaceChat = {
  workspaceId: string
  executionHostId: ExecutionHostId
  sessionId: string
  agent: string
  title: string
}

type ChatStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
const STORAGE_PREFIX = 'orca.workspaceChats.v1:'

export function workspaceChatKey(
  chat: Pick<WorkspaceChat, 'workspaceId' | 'executionHostId' | 'sessionId'>
): string {
  return JSON.stringify([chat.workspaceId, chat.executionHostId, chat.sessionId])
}

function readChat(raw: string | null): WorkspaceChat | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!isRecord(value)) {
      return null
    }
    const chat = value
    const host =
      typeof chat.executionHostId === 'string'
        ? parseRoutableExecutionHostId(chat.executionHostId)
        : null
    if (
      typeof chat.workspaceId !== 'string' ||
      !chat.workspaceId ||
      typeof chat.sessionId !== 'string' ||
      !chat.sessionId ||
      !host ||
      typeof chat.agent !== 'string' ||
      !chat.agent ||
      typeof chat.title !== 'string' ||
      !chat.title
    ) {
      return null
    }
    return {
      workspaceId: chat.workspaceId,
      executionHostId: host.id,
      sessionId: chat.sessionId,
      agent: chat.agent,
      title: chat.title.slice(0, 300)
    }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Closed chats retain navigation metadata, never a tab, reader or transcript. */
export class WorkspaceChatCatalog {
  private chats = new Map<string, WorkspaceChat>()
  private snapshot: readonly WorkspaceChat[] = []
  private listeners = new Set<() => void>()

  constructor(private readonly storage: ChatStorage | null) {
    try {
      for (let index = 0; index < (storage?.length ?? 0); index++) {
        const key = storage!.key(index)
        if (!key?.startsWith(STORAGE_PREFIX)) {
          continue
        }
        const chat = readChat(storage!.getItem(key))
        if (chat && key === STORAGE_PREFIX + workspaceChatKey(chat)) {
          this.chats.set(workspaceChatKey(chat), chat)
        }
      }
      this.snapshot = [...this.chats.values()]
    } catch {
      // Storage may be disabled; closing still keeps chats in this window.
    }
  }

  getSnapshot = (): readonly WorkspaceChat[] => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  remember(chat: WorkspaceChat): void {
    const key = workspaceChatKey(chat)
    const saved = { ...chat, title: chat.title.slice(0, 300) }
    this.chats.set(key, saved)
    try {
      this.storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(saved))
    } catch {
      // Keep navigation available even when the profile cannot be written.
    }
    this.publish()
  }

  archive(chat: Pick<WorkspaceChat, 'workspaceId' | 'executionHostId' | 'sessionId'>): void {
    const key = workspaceChatKey(chat)
    this.chats.delete(key)
    try {
      this.storage?.removeItem(STORAGE_PREFIX + key)
    } catch {
      // The current window can still hide the entry.
    }
    this.publish()
  }

  acceptStorageChange(key: string | null, value: string | null): void {
    if (key === null) {
      this.chats.clear()
    } else if (key.startsWith(STORAGE_PREFIX)) {
      const identity = key.slice(STORAGE_PREFIX.length)
      const chat = readChat(value)
      if (chat && workspaceChatKey(chat) === identity) {
        this.chats.set(identity, chat)
      } else {
        this.chats.delete(identity)
      }
    } else {
      return
    }
    this.publish()
  }

  private publish(): void {
    this.snapshot = [...this.chats.values()]
    for (const listener of this.listeners) {
      listener()
    }
  }
}

let catalog: WorkspaceChatCatalog | undefined

export function workspaceChatCatalog(): WorkspaceChatCatalog {
  if (!catalog) {
    let storage: Storage | null = null
    try {
      storage = typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      // The browser can deny profile storage access.
    }
    catalog = new WorkspaceChatCatalog(storage)
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.storageArea === storage) {
          catalog?.acceptStorageChange(event.key, event.newValue)
        }
      })
    }
  }
  return catalog
}
