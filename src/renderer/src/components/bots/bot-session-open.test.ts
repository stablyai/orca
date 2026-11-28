import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The slice of the app store a bot open and a thread link's navigation watch read. */
type StoreState = {
  activeView: string
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: string | null
  activePendingCreationId: string | null
  unifiedTabsByWorktree: Record<string, readonly string[]>
  fetchFolderWorkspaces: (args: unknown) => Promise<void>
}
/** Called as zustand calls its listeners, with the state after and before the write. */
type StoreListener = (state: StoreState, previous: StoreState) => void

const mocks = vi.hoisted(() => {
  const listeners = new Set<StoreListener>()
  const state: StoreState = {
    activeView: 'terminal',
    activeWorkspaceKey: 'folder:elsewhere',
    activeWorktreeId: 'folder:elsewhere',
    activeWorkspaceExecutionHostId: null,
    activePendingCreationId: null,
    unifiedTabsByWorktree: {},
    fetchFolderWorkspaces: async () => {}
  }
  const write = (change: () => void): void => {
    const previous = { ...state }
    change()
    listeners.forEach((listener) => listener(state, previous))
  }
  return {
    state,
    listeners,
    fetchFolderWorkspaces: vi.fn(),
    admit: vi.fn(),
    activate: vi.fn(),
    unavailable: vi.fn(),
    callBotRpc: vi.fn(),
    /** The user shows another workspace, as a workspace switch writes the store. */
    show: (workspace: string): void =>
      write(() => {
        state.activeWorkspaceKey = workspace
        state.activeWorktreeId = workspace
      }),
    /** The pending-creation row's click: setActivePendingWorktreeCreation writes only this field. */
    pickPending: (creationId: string | null): void =>
      write(() => {
        state.activePendingCreationId = creationId
      }),
    /** A server tab frame: tabs change inside a workspace; which workspace is shown does not. */
    tabFrame: (workspace: string, tabs: readonly string[]): void =>
      write(() => {
        state.unifiedTabsByWorktree = { ...state.unifiedTabsByWorktree, [workspace]: tabs }
      }),
    /** A store write that changes no workspace selection, like a catalog read. */
    touch: (): void => write(() => {})
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: (listener: StoreListener) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspaceWithOutcome: mocks.admit
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
vi.mock('@/lib/agent-session/open/chat-open-failure-toast', () => ({
  showChatOpenUnavailable: mocks.unavailable
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-session/open/bot-link-item-target', () => ({ targetBotChatLatest: vi.fn() }))
vi.mock('@/lib/focused-chat-workers', () => ({ selectFocusedChatTab: () => null }))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: vi.fn()
}))
vi.mock('@/runtime/rpc/targets/runtime-client-target', () => ({
  runtimeTargetEnvironmentId: (target: { kind: string; environmentId?: string }) =>
    target.kind === 'environment' ? target.environmentId : null
}))
vi.mock('@/lib/bot-hosts', () => ({
  botTarget: (bot: { hostId: string }) =>
    bot.hostId === 'local'
      ? { kind: 'local' }
      : { kind: 'environment', environmentId: bot.hostId.replace('runtime:', '') },
  callBotRpc: mocks.callBotRpc
}))

import {
  cancelPendingBotThreadOpen,
  runBotThreadOpen
} from '@/lib/agent-session/open/bot-thread-open-lifecycle'
import { withBotThreadOpenNavigation } from '@/lib/agent-session/open/bot-thread-open-navigation'
import { openBotChatTab, openBotSession, startAndOpenBotChat } from './bot-session-open'

const opened = { opened: {} }
const missing = { refused: { reason: 'workspace-missing', failureNotified: false } }
const blocked = { refused: { reason: 'path-blocked', failureNotified: true } }
const serverBot = { id: 'bot-1', folderWorkspaceId: 'home-1', hostId: 'runtime:env-1' } as const
const chatOne = { structuredSession: { sessionId: 'chat-1', workspaceId: 'folder:home-1' } }

/** Host calls that would start or reset a chat; recovery must never make them. */
function hostStartsOrResets(): unknown[] {
  return mocks.callBotRpc.mock.calls
    .map(([, method]) => method)
    .filter((method) => method === 'bots.session.start' || method === 'bots.chat.reset')
}

/** A folder-list read that stays pending until `answer` runs, which also lists the Home. */
function heldFolderList(): { answer: () => void } {
  let answer = (): void => {}
  mocks.fetchFolderWorkspaces.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        answer = () => {
          mocks.admit.mockReturnValue(opened)
          resolve()
        }
      })
  )
  return { answer: () => answer() }
}

/** An external thread link still opening; `signal` aborts when a newer navigation takes over. */
function pendingThreadLink(key: string): { signal: AbortSignal } {
  let signal: AbortSignal | undefined
  void runBotThreadOpen(
    key,
    (abort) =>
      new Promise<void>((resolve) => {
        signal = abort
        abort.addEventListener('abort', () => resolve())
      })
  )
  if (!signal) {
    throw new Error('the thread link did not start')
  }
  return { signal }
}

function reset(): void {
  cancelPendingBotThreadOpen()
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.state.activeWorkspaceKey = 'folder:elsewhere'
  mocks.state.activeWorktreeId = 'folder:elsewhere'
  mocks.state.activePendingCreationId = null
  mocks.state.unifiedTabsByWorktree = {}
  mocks.state.fetchFolderWorkspaces = mocks.fetchFolderWorkspaces
  mocks.fetchFolderWorkspaces.mockResolvedValue(undefined)
  mocks.activate.mockResolvedValue(true)
  mocks.callBotRpc.mockResolvedValue(undefined)
}

describe('openBotChatTab', () => {
  beforeEach(reset)

  it('opens a server bot Home before the chat, on the bot’s host', async () => {
    mocks.admit.mockReturnValue(opened)
    await expect(openBotChatTab(serverBot, 'chat-1')).resolves.toBe(true)
    expect(mocks.admit).toHaveBeenCalledWith('home-1', {
      executionHostId: 'runtime:env-1',
      revealInSidebar: false
    })
    expect(mocks.activate).toHaveBeenCalledWith(
      chatOne,
      { retry: expect.any(Function) },
      { kind: 'environment', environmentId: 'env-1' }
    )
    expect(mocks.admit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activate.mock.invocationCallOrder[0]
    )
    expect(mocks.listeners.size).toBe(0)
  })

  it('offers Retry when the Home list failed, and Retry opens the same chat once it loads', async () => {
    mocks.admit.mockReturnValue(missing)
    mocks.fetchFolderWorkspaces.mockRejectedValueOnce(new Error('list failed'))
    await expect(openBotChatTab(serverBot, 'chat-1')).resolves.toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.unavailable).toHaveBeenCalledTimes(1)
    const { retry, message, detail } = mocks.unavailable.mock.calls[0][0]
    // One plain body line; there is no raw output, so no details disclosure.
    expect(message).toBe("Bot's Home didn't load.")
    expect(detail).toBeUndefined()

    mocks.fetchFolderWorkspaces.mockImplementationOnce(async () => {
      mocks.admit.mockReturnValue(opened)
    })
    retry()
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1))
    expect(mocks.activate.mock.calls[0][0]).toEqual(chatOne)
    expect(hostStartsOrResets()).toEqual([])
  })

  it('a failed chat open’s Retry repeats the Home step too', async () => {
    mocks.admit.mockReturnValue(opened)
    await openBotChatTab(serverBot, 'chat-1')
    const retry: unknown = mocks.activate.mock.calls[0][1]?.retry
    mocks.admit.mockClear()
    expect(retry).toBeTypeOf('function')
    if (typeof retry === 'function') {
      await retry()
    }
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.activate).toHaveBeenCalledTimes(2)
    expect(mocks.activate.mock.calls[1][0]).toEqual(chatOne)
  })

  it('a blocked Home path keeps its own notice; the chat row reopens the same chat once the path is back', async () => {
    mocks.admit.mockReturnValue(blocked)
    await expect(openBotChatTab(serverBot, 'chat-1')).resolves.toBe(false)
    expect(mocks.unavailable).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()

    // The folder is back; the user clicks the chat's row in the bot's Chats list.
    mocks.admit.mockReturnValue(opened)
    openBotSession(serverBot, 'chat-1')
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1))
    expect(mocks.activate.mock.calls[0][0]).toEqual(chatOne)
    expect(hostStartsOrResets()).toEqual([])
  })

  it('opens a bot on this computer without a Home step', async () => {
    await openBotChatTab({ ...serverBot, hostId: 'local' }, 'chat-1')
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending thread link at the click, before the Home list loads', async () => {
    const older = pendingThreadLink('link-a')
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    expect(older.signal.aborted).toBe(true)
    list.answer()
    await expect(open).resolves.toBe(true)
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it('yields to a thread link opened while the Home list loads, leaving it pending', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    const newer = pendingThreadLink('link-b')
    list.answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(newer.signal.aborted).toBe(false)
  })

  it('leaves a newer thread link opening when the older chat’s Home list answers', async () => {
    // Admitting the Home selects it, which the link's own navigation watch reads as a newer move.
    mocks.admit.mockImplementation(() => {
      if (mocks.fetchFolderWorkspaces.mock.calls.length === 0) {
        return missing
      }
      mocks.show('folder:home-1')
      return opened
    })
    let answer = (): void => {}
    mocks.fetchFolderWorkspaces.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve
        })
    )
    const open = openBotChatTab(serverBot, 'chat-1')
    await vi.waitFor(() => expect(mocks.fetchFolderWorkspaces).toHaveBeenCalledTimes(1))
    let link: AbortSignal | undefined
    void runBotThreadOpen('link-b', (signal) => {
      link = signal
      return withBotThreadOpenNavigation(
        signal,
        () => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      )
    })
    answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.state.activeWorkspaceKey).toBe('folder:elsewhere')
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(link?.aborted).toBe(false)
  })

  it('stays put when the user moves to another workspace while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.show('folder:other')
    list.answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.unavailable).not.toHaveBeenCalled()
    expect(mocks.state.activeWorkspaceKey).toBe('folder:other')
  })

  it('stays put when the user goes elsewhere and comes back while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.show('folder:other')
    mocks.show('folder:elsewhere')
    list.answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('stays put when the user picks a workspace still being created while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.pickPending('creation-1')
    list.answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.state.activePendingCreationId).toBe('creation-1')
  })

  it('stays put when the user picks a pending workspace and leaves it while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.pickPending('creation-1')
    mocks.pickPending(null)
    list.answer()
    await expect(open).resolves.toBe(false)
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('still opens when a server tab frame lands while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.tabFrame('folder:elsewhere', ['agent-session:chat-2'])
    list.answer()
    await expect(open).resolves.toBe(true)
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })

  it('still opens when only the catalog changes while the Home list loads', async () => {
    mocks.admit.mockReturnValue(missing)
    const list = heldFolderList()
    const open = openBotChatTab(serverBot, 'chat-1')
    mocks.touch()
    list.answer()
    await expect(open).resolves.toBe(true)
    expect(mocks.admit).toHaveBeenCalledTimes(2)
    expect(mocks.activate).toHaveBeenCalledTimes(1)
  })
})

describe('startAndOpenBotChat', () => {
  beforeEach(() => {
    reset()
    mocks.admit.mockReturnValue(opened)
  })

  it('opens the started chat when the user stayed where they clicked', async () => {
    startAndOpenBotChat(serverBot, async () => 'chat-1', vi.fn())
    await vi.waitFor(() => expect(mocks.activate).toHaveBeenCalledTimes(1))
    expect(mocks.admit).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
  })

  it('leaves the window where the user moved while the host started the chat', async () => {
    let started = (_sessionId: string): void => {}
    startAndOpenBotChat(
      serverBot,
      () =>
        new Promise<string>((resolve) => {
          started = resolve
        }),
      vi.fn()
    )
    mocks.show('folder:other')
    started('chat-1')
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
    await Promise.resolve()
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.state.activeWorkspaceKey).toBe('folder:other')
  })

  it('leaves a pending workspace the user picked while the host started the chat in front', async () => {
    let started = (_sessionId: string): void => {}
    startAndOpenBotChat(
      serverBot,
      () =>
        new Promise<string>((resolve) => {
          started = resolve
        }),
      vi.fn()
    )
    mocks.pickPending('creation-1')
    started('chat-1')
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
    await Promise.resolve()
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.state.activePendingCreationId).toBe('creation-1')
  })

  it('cancels a pending thread link at the click, before the host starts the chat', () => {
    const older = pendingThreadLink('link-a')
    startAndOpenBotChat(serverBot, () => new Promise<string>(() => {}), vi.fn())
    expect(older.signal.aborted).toBe(true)
  })

  it('yields to a thread link opened while the host started the chat', async () => {
    let started = (_sessionId: string): void => {}
    startAndOpenBotChat(
      serverBot,
      () =>
        new Promise<string>((resolve) => {
          started = resolve
        }),
      vi.fn()
    )
    const newer = pendingThreadLink('link-b')
    started('chat-1')
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
    await Promise.resolve()
    expect(mocks.admit).not.toHaveBeenCalled()
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(newer.signal.aborted).toBe(false)
  })

  it('reports a failed start and stops watching', async () => {
    const onError = vi.fn()
    startAndOpenBotChat(serverBot, () => Promise.reject(new Error('no agent')), onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.listeners.size).toBe(0))
    expect(mocks.activate).not.toHaveBeenCalled()
  })
})
