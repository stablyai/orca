// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import type { Bot } from '../../../../shared/bot-types'
import type { Tab, TabGroup } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import type { BotChatTree } from './use-bot-chat-tree'
import BotChatsPanel from './BotChatsPanel'
import { readBotSettingsPlace, setBotSettingsPlace } from './settings-view/bot-settings-place'

const bot: Bot = {
  id: 'bot-1',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: 'mascot:Q1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const workspaceId = 'folder:home-1'

const tree = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const snapshot: { current: BotChatTree | null } = { current: null }
  return {
    snapshot,
    listeners,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
})
const opened = vi.hoisted(() => vi.fn())
vi.mock('./use-bot-chat-tree', async () => {
  const { useSyncExternalStore } = await import('react')
  const useTree = () => useSyncExternalStore(tree.subscribe, () => tree.snapshot.current)
  return { useBotChatTree: useTree, useBotOwnChatTree: useTree }
})
vi.mock('./bot-workspace', () => ({ useBotForWorkspace: () => bot }))
const host = vi.hoisted(() => ({ offline: false }))
vi.mock('@/lib/bot-host-views', () => ({ useBotHostOffline: () => host.offline }))
vi.mock('./use-bot-now', () => ({
  useBotNow: () => ({ needs: [], stoppedForSignIn: [], work: [], needsYou: 0, working: 0 }),
  useBotNeedsYouCount: () => 0
}))
vi.mock('./bot-session-open', () => ({ openBotSession: opened }))

const worker = (key: string, state: BotChatTreeWorker['state']): BotChatTreeWorker => ({
  key,
  title: `Worker ${key}`,
  state,
  startedAt: 0,
  settledAt: state === 'done' ? 1 : undefined
})

function chat(chatId: string, patch: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  return {
    chatId,
    title: 'Connector fix rollout',
    origin: 'side',
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...patch
  }
}

const rollout = chat('rollout', {
  running: [worker('r1', 'running')],
  runningTotal: 1,
  finished: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((key) => worker(key, 'done')),
  finishedTotal: 6
})

function showTree(patch: Partial<BotChatTree>): void {
  const value: BotChatTree = {
    chats: [],
    workspaceChats: {},
    loadMore: vi.fn(),
    state: 'ready',
    retry: vi.fn(),
    ...patch
  }
  tree.snapshot.current = value
  for (const listener of tree.listeners) {
    listener()
  }
}

/** Makes the chat's tab the front one on the bot's page, so its row is the active one. */
function frontTab(chatId: string): void {
  const tab: Tab = {
    id: `structured-agent-session-${chatId}`,
    entityId: chatId,
    groupId: 'group-1',
    worktreeId: workspaceId,
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const group: TabGroup = {
    id: 'group-1',
    worktreeId: workspaceId,
    activeTabId: tab.id,
    tabOrder: [tab.id],
    recentTabIds: []
  }
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: workspaceId,
    activeWorkspaceKey: workspaceId,
    activeGroupIdByWorktree: { [workspaceId]: 'group-1' },
    groupsByWorktree: { [workspaceId]: [group] },
    unifiedTabsByWorktree: { [workspaceId]: [tab] }
  })
}

function renderPanel(): void {
  render(<BotChatsPanel />, { wrapper: TooltipProvider })
}

beforeEach(() => {
  vi.stubGlobal('api', { ui: { set: vi.fn(async () => undefined) } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  opened.mockReset()
  host.offline = false
  setBotSettingsPlace('panel', null)
  useAppStore.setState({ botChatFolds: {} })
})

describe('the Chats tab', () => {
  it('starts every chat folded, whatever the sidebar has open, and unfolds to five workers', () => {
    useAppStore.getState().setBotChatFold('local', 'bot-1', 'rollout', 'open')
    showTree({ chats: [{ ...rollout, running: [worker('r1', 'needs-you')] }] })
    renderPanel()
    expect(screen.queryByText('Worker r1')).toBeNull()
    expect(screen.getByRole('img', { name: '1 waiting' })).toBeTruthy()
    expect(screen.queryByText(/running/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Unfold Connector fix rollout' }))

    expect(screen.getByText('Worker r1')).toBeTruthy()
    expect(screen.getByText('Worker f4')).toBeTruthy()
    expect(screen.queryByText('Worker f5')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeTruthy()
    // Folding here leaves the sidebar's fold alone, and the other way round.
    fireEvent.click(screen.getByRole('button', { name: 'Fold Connector fix rollout' }))
    expect(useAppStore.getState().botChatFold('local', 'bot-1', 'rollout')).toBe('open')
    useAppStore.getState().setBotChatFold('local', 'bot-1', 'rollout', 'folded')
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Connector fix rollout' }))
    expect(useAppStore.getState().botChatFold('local', 'bot-1', 'rollout')).toBe('folded')
    expect(screen.getByText('Worker r1')).toBeTruthy()
  })

  it('opens the chat that is already in front when its row is pressed, without unfolding it', () => {
    frontTab('rollout')
    showTree({ chats: [rollout] })
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /^Connector fix rollout · Side chat/ }))

    expect(opened).toHaveBeenCalledWith(bot, 'rollout')
    expect(screen.queryByText('Worker r1')).toBeNull()
  })

  it("shows Activity's header while the host is offline, its actions off and its gear opening settings in Activity", () => {
    host.offline = true
    useAppStore.setState({ rightSidebarTab: 'bot-chats' })
    showTree({ chats: [rollout] })
    renderPanel()
    expect(screen.getByText('Bot builder')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New chat' }).closest('fieldset')?.disabled).toBe(
      true
    )
    expect(
      screen.getByRole('button', { name: 'Unfold Connector fix rollout' }).closest('fieldset')
        ?.disabled
    ).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Bot settings…' }))

    expect(readBotSettingsPlace('panel')).toEqual({ botId: 'bot-1', page: null })
    expect(useAppStore.getState().rightSidebarTab).toBe('bot-activity')
  })

  it('shows loading, offers retry on failure and renders the chat once retry succeeds', () => {
    const retry = vi.fn()
    showTree({ state: 'loading' })
    renderPanel()
    expect(screen.getByText('Loading chats…')).toBeTruthy()

    act(() => showTree({ state: 'failed', retry }))
    expect(screen.getByText(/Couldn't read this bot's chats/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)

    act(() => showTree({ chats: [rollout] }))
    expect(screen.getByRole('button', { name: /^Connector fix rollout · Side chat/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('sends an older host to Home, where its work still shows', () => {
    showTree({ state: 'unsupported' })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'See its work in Home' }))
    expect(useAppStore.getState().rightSidebarTab).toBe('bot-activity')
  })
})
