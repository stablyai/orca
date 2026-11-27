import { describe, expect, it } from 'vitest'
import { WorkspaceChatCatalog, type WorkspaceChat } from './workspace-chats'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    }
  }
}

const chat = {
  workspaceId: 'folder-workspace-one',
  executionHostId: 'local' as const,
  sessionId: 'conversation-one',
  agent: 'codex',
  title: 'Website navigation'
}

describe('workspace chat catalog', () => {
  it('keeps a closed chat available after reload without retaining its tab', () => {
    const storage = memoryStorage()
    new WorkspaceChatCatalog(storage).remember(chat)
    expect(new WorkspaceChatCatalog(storage).getSnapshot()).toEqual([chat])
  })

  it('updates a reopened conversation without duplicating its workspace entry', () => {
    const catalog = new WorkspaceChatCatalog(memoryStorage())
    catalog.remember(chat)
    catalog.remember({ ...chat, title: 'New navigation title' })
    expect(catalog.getSnapshot()).toEqual([{ ...chat, title: 'New navigation title' }])
  })

  it('archives only the selected workspace and host conversation across reload', () => {
    const storage = memoryStorage()
    const catalog = new WorkspaceChatCatalog(storage)
    const otherWorkspace = { ...chat, workspaceId: 'folder-workspace-two' }
    const otherHost: WorkspaceChat = { ...chat, executionHostId: 'runtime:other-computer' }
    catalog.remember(chat)
    catalog.remember(otherWorkspace)
    catalog.remember(otherHost)
    catalog.archive(chat)
    expect(new WorkspaceChatCatalog(storage).getSnapshot()).toEqual([otherWorkspace, otherHost])
  })

  it('does not overwrite another window when it remembers or archives a chat', () => {
    const storage = memoryStorage()
    const first = new WorkspaceChatCatalog(storage)
    const second = new WorkspaceChatCatalog(storage)
    first.remember(chat)
    second.remember({ ...chat, sessionId: 'conversation-two' })
    first.archive(chat)
    expect(new WorkspaceChatCatalog(storage).getSnapshot()).toEqual([
      { ...chat, sessionId: 'conversation-two' }
    ])
  })

  it('keeps an archived chat hidden after a delayed save from another window', () => {
    const storage = memoryStorage()
    const otherWindow = new WorkspaceChatCatalog(storage)
    const catalog = new WorkspaceChatCatalog(storage)
    otherWindow.remember(chat)
    const key = storage.key(0)!

    catalog.archive(chat)
    catalog.acceptStorageChange(key)

    expect(catalog.getSnapshot()).toEqual([])
  })

  it('continues in memory when storage is unavailable and skips corrupt records', () => {
    const storage = memoryStorage()
    const catalog = new WorkspaceChatCatalog(storage)
    catalog.remember(chat)
    const key = storage.key(0)!
    storage.setItem(key, '{invalid json')
    expect(new WorkspaceChatCatalog(storage).getSnapshot()).toEqual([])
    const unavailable = new WorkspaceChatCatalog({
      ...storage,
      setItem() {
        throw new Error('Quota exceeded')
      },
      removeItem() {
        throw new Error('Storage unavailable')
      }
    })
    unavailable.remember(chat)
    expect(unavailable.getSnapshot()).toEqual([chat])
    unavailable.archive(chat)
    expect(unavailable.getSnapshot()).toEqual([])
  })
})
