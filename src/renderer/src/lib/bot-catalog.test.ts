// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  activateAndRevealFolderWorkspace: vi.fn(() => ({ primaryTabId: null })),
  activateHomeTab: vi.fn(),
  activateHomeTabHere: vi.fn((): boolean => false),
  fetchFolderWorkspaces: vi.fn(async () => {}),
  appendDraft: vi.fn(),
  focusComposer: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace
}))
vi.mock('./agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateHomeTabHere,
  activateStructuredAgentSessionTabOnOwner: mocks.activateHomeTab
}))
vi.mock('@/components/native-chat/drafts/native-chat-draft-views', () => ({
  appendNativeChatDraftCache: mocks.appendDraft
}))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: mocks.focusComposer
}))

import {
  isHome,
  openBotHomeTab,
  openBotHomeTabById,
  refreshBots,
  updateBot,
  useBots,
  useHostBots
} from './bot-catalog'
import {
  publishBots,
  readBotItemsNeedingOwner,
  readBotWebhooks,
  setBotHostListing
} from './bot-catalog-snapshot'
import { emitBotsChangedWindowEvent } from './bots-changed-window-event'
import { useAppStore } from '@/store'

function bot(name: string): Bot {
  return {
    id: name,
    name,
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: `fw-${name}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

afterEach(() => {
  cleanup()
  mocks.callRuntimeRpc.mockReset()
})

describe('useBots', () => {
  it('lists bots on first use and again on refresh', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Reviewer')] })
    const view = renderHook(() => useBots())
    await waitFor(() => expect(view.result.current.map((b) => b.name)).toEqual(['Reviewer']))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.list', undefined, {
      timeoutMs: 30_000
    })

    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Reviewer'), bot('Scout')] })
    await act(() => refreshBots())
    expect(view.result.current).toHaveLength(2)
  })

  it("carries the host's word on webhooks, and none from an older host", async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Reviewer')], webhooks: false })
    await refreshBots()
    expect(readBotWebhooks('local')).toBe(false)
    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Reviewer')] })
    await refreshBots()
    expect(readBotWebhooks('local')).toBeUndefined()
  })

  it('reads again after a slow read, so the newest list wins', async () => {
    const view = renderHook(() => useBots())

    let answerOlder: (value: { bots: Bot[] }) => void = () => {}
    mocks.callRuntimeRpc.mockReturnValueOnce(new Promise((resolve) => (answerOlder = resolve)))
    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Renamed')] })
    const older = refreshBots()
    const newer = refreshBots()
    // One read out per host: the second waits for the first.
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    answerOlder({ bots: [bot('Original')] })
    await act(() => Promise.all([older, newer]))
    expect(view.result.current.map((b) => b.name)).toEqual(['Renamed'])
  })
})

describe('useHostBots', () => {
  it('lists none once the host itself is no longer listed', () => {
    const server = 'runtime:env-gone' as const
    mocks.callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: server, state: 'live' }
      ],
      updateNeeded: []
    })
    publishBots([bot('Reviewer')], undefined, server)
    const view = renderHook(() => useHostBots(server))
    expect(view.result.current.map((b) => b.name)).toEqual(['Reviewer'])

    act(() => {
      setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
    })
    expect(view.result.current).toEqual([])
  })
})

describe('updateBot', () => {
  it('shows a change at once and keeps a later one when an earlier answer lands first', async () => {
    const view = renderHook(() => useBots())
    mocks.callRuntimeRpc.mockResolvedValueOnce({ bots: [bot('Reviewer')] })
    await act(() => refreshBots())

    const answers: ((value: unknown) => void)[] = []
    mocks.callRuntimeRpc.mockImplementation(
      (_target: unknown, method: string) =>
        new Promise((resolve) =>
          method === 'bots.list' ? resolve({ bots: view.result.current }) : answers.push(resolve)
        )
    )
    const off = { needsPermission: false, taskComplete: true, couldNotFinish: true }
    let first: Promise<Bot> = Promise.resolve(bot('x'))
    let second: Promise<Bot> = Promise.resolve(bot('x'))
    act(() => {
      first = updateBot({ hostId: 'local', id: 'Reviewer' }, { notifications: off })
    })
    expect(view.result.current[0].notifications).toEqual(off)
    act(() => {
      second = updateBot(
        { hostId: 'local', id: 'Reviewer' },
        {
          notifications: { ...view.result.current[0].notifications, taskComplete: false }
        }
      )
    })
    answers[0]({ bot: { ...bot('Reviewer'), notifications: off } })
    await act(() => first)
    expect(view.result.current[0].notifications).toEqual({
      needsPermission: false,
      taskComplete: false,
      couldNotFinish: true
    })
    answers[1]({ bot: view.result.current[0] })
    await act(() => second)
    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'bots.list',
      undefined,
      {
        timeoutMs: 30_000
      }
    )
  })
})

describe('isHome', () => {
  it('matches a bot home by id on the bot host only', () => {
    const bots = [bot('Reviewer')]
    expect(isHome({ id: 'fw-Reviewer', executionHostId: 'local' }, bots)).toBe(true)
    expect(isHome({ id: 'fw-Reviewer', executionHostId: 'ssh:box' }, bots)).toBe(false)
    expect(isHome({ id: 'fw-other', executionHostId: 'local' }, bots)).toBe(false)
  })
})

describe('openBotHomeTabById', () => {
  it('opens the bot’s page on its Home tab, reading the list when none is loaded', async () => {
    useAppStore.setState({ fetchFolderWorkspaces: mocks.fetchFolderWorkspaces })
    mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.list' ? { bots: [bot('Linked')] } : { sessionId: 'home-chat' }
    )

    await expect(openBotHomeTabById({ hostId: 'local', id: 'Linked' })).resolves.toBe(true)

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.chat.open', {
      botId: 'Linked'
    })
    expect(mocks.activateAndRevealFolderWorkspace).toHaveBeenCalledWith('fw-Linked', {
      executionHostId: 'local',
      revealInSidebar: false
    })
    // The Home tab, not whichever tab the bot's page last showed.
    expect(mocks.activateHomeTab).toHaveBeenCalledWith('folder:fw-Linked', 'home-chat')
    expect(mocks.appendDraft).not.toHaveBeenCalled()
  })

  it('adds a draft to Home’s unsent message, without sending it, and focuses its composer', async () => {
    useAppStore.setState({ fetchFolderWorkspaces: mocks.fetchFolderWorkspaces })
    mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.list' ? { bots: [bot('Drafted')] } : { sessionId: 'home-chat' }
    )

    await expect(
      openBotHomeTab(bot('Drafted'), { draft: 'Set up an automation that ' })
    ).resolves.toBe(true)

    expect(mocks.appendDraft).toHaveBeenCalledWith(
      'agent-session:home-chat',
      'Set up an automation that '
    )
    // The draft lands once: the cache carries it, so the focus request must not append it again.
    expect(mocks.appendDraft).toHaveBeenCalledTimes(1)
    expect(mocks.focusComposer).toHaveBeenCalledWith('structured-agent-session-home-chat', {
      revealDraft: true
    })
    expect(mocks.focusComposer.mock.calls.some(([, options]) => 'append' in (options ?? {}))).toBe(
      false
    )
    expect(mocks.callRuntimeRpc.mock.calls.map((call) => call[1])).toEqual([
      'bots.chat.open',
      'bots.list'
    ])
  })

  it('switches to a Home tab already open here, and asks for focus after that switch', async () => {
    useAppStore.setState({ fetchFolderWorkspaces: mocks.fetchFolderWorkspaces })
    mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.list' ? { bots: [bot('Open')] } : { sessionId: 'home-chat' }
    )
    mocks.activateHomeTab.mockClear()
    mocks.activateHomeTabHere.mockReturnValueOnce(true)
    mocks.focusComposer.mockClear()

    await openBotHomeTab(bot('Open'), { draft: 'Set up an automation that ' })

    expect(mocks.activateHomeTabHere).toHaveBeenCalledWith({
      worktreeId: 'folder:fw-Open',
      sessionId: 'home-chat'
    })
    expect(mocks.activateHomeTab).not.toHaveBeenCalled()
    // The switch makes its own focus request, which the draft's must replace.
    expect(mocks.focusComposer.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.activateHomeTabHere.mock.invocationCallOrder.at(-1)!
    )
  })

  it('opens nothing for an unknown or deleted bot', async () => {
    mocks.activateAndRevealFolderWorkspace.mockClear()
    mocks.activateHomeTab.mockClear()
    mocks.callRuntimeRpc.mockResolvedValue({ bots: [] })

    await expect(openBotHomeTabById({ hostId: 'local', id: 'Gone' })).resolves.toBe(false)

    expect(mocks.activateAndRevealFolderWorkspace).not.toHaveBeenCalled()
    expect(mocks.activateHomeTab).not.toHaveBeenCalled()
  })
})

describe('listed Needs you items', () => {
  it('keeps each bot’s count from its host’s list read, with no read of its own', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      bots: [bot('Reviewer'), bot('Scout')],
      needsYou: { Reviewer: 2 }
    })
    renderHook(() => useBots())
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner({ id: 'Reviewer', hostId: 'local' })).toBe(2)
    expect(readBotItemsNeedingOwner({ id: 'Scout', hostId: 'local' })).toBe(0)

    // An older host sends no counts: none is claimed.
    mocks.callRuntimeRpc.mockResolvedValue({ bots: [bot('Reviewer')] })
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner({ id: 'Reviewer', hostId: 'local' })).toBeNull()
  })
})

describe('Needs you counts on items notices', () => {
  const reviewer = { id: 'Reviewer', hostId: 'local' as const }

  it('keeps a later count over an earlier list read landing late, and reads the list for a notice without counts', async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      bots: [bot('Reviewer')],
      needsYou: { Reviewer: 1 },
      needsYouAt: 200_000
    })
    renderHook(() => useBots())
    await act(() => refreshBots())
    act(() =>
      emitBotsChangedWindowEvent('local', {
        kinds: ['items'],
        needsYou: { counts: { Reviewer: 3 }, at: 300_000 }
      })
    )
    expect(readBotItemsNeedingOwner(reviewer)).toBe(3)
    // Counted before the notice's: it changes nothing.
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner(reviewer)).toBe(3)

    // An older host's items notice carries no counts: the list is read again.
    mocks.callRuntimeRpc.mockResolvedValue({
      bots: [bot('Reviewer')],
      needsYou: {},
      needsYouAt: 400_000
    })
    await act(async () => {
      emitBotsChangedWindowEvent('local', { kinds: ['items'] })
      await Promise.resolve()
    })
    await waitFor(() => expect(readBotItemsNeedingOwner(reviewer)).toBe(0))
  })

  it("keeps the last counts when the host's count fails, and counts again when it reads", async () => {
    mocks.callRuntimeRpc.mockResolvedValue({
      bots: [bot('Reviewer')],
      needsYou: { Reviewer: 4 },
      needsYouAt: 450_000
    })
    renderHook(() => useBots())
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner(reviewer)).toBe(4)
    // The count failed: the list says nothing of it.
    mocks.callRuntimeRpc.mockResolvedValue({ bots: [bot('Reviewer')] })
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner(reviewer)).toBe(4)
    mocks.callRuntimeRpc.mockResolvedValue({
      bots: [bot('Reviewer')],
      needsYou: { Reviewer: 1 },
      needsYouAt: 460_000
    })
    await act(() => refreshBots())
    expect(readBotItemsNeedingOwner(reviewer)).toBe(1)
  })

  it('reads the list again as the next counted item goes stale', async () => {
    vi.useFakeTimers()
    try {
      mocks.callRuntimeRpc.mockResolvedValue({
        bots: [bot('Reviewer')],
        needsYou: { Reviewer: 1 },
        needsYouAt: 500_000
      })
      renderHook(() => useBots())
      await act(() => refreshBots())
      act(() =>
        emitBotsChangedWindowEvent('local', {
          kinds: ['items'],
          needsYou: { counts: { Reviewer: 2 }, at: 600_000, staleInMs: 60_000 }
        })
      )
      mocks.callRuntimeRpc.mockResolvedValue({
        bots: [bot('Reviewer')],
        needsYou: { Reviewer: 1 },
        needsYouAt: 700_000
      })
      await act(() => vi.advanceTimersByTimeAsync(59_000))
      expect(readBotItemsNeedingOwner(reviewer)).toBe(2)
      await act(() => vi.advanceTimersByTimeAsync(2_000))
      expect(readBotItemsNeedingOwner(reviewer)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
