// @vitest-environment happy-dom
// "Reveal current" in the Bots section: it unfolds the path to the row in front, ends a search hiding
// the list, and renames only the Bots line. The glow and the scroll are checked in the e2e.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as BotCatalog from '@/lib/bot-catalog'
import type * as BotCatalogSnapshot from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import {
  requestScrollToCurrentWorkspaceReveal,
  requestScrollToCurrentWorkspaceRevealAndRename
} from '@/lib/workspace/navigation/scroll-to-current-workspace-status'
import WorktreeCard from '@/components/sidebar/workspace-card/surface/WorktreeCard'
import { botWorkerLineRowKey } from '../../../../shared/sidebar-list/sidebar-reveal-target'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import {
  BOTS_GROUP_KEY,
  getLineageGroupKey,
  PROJECTS_SECTION_GROUP_KEY
} from '../../../../shared/sidebar-list/sections/group-keys'
import { botChatFoldKey } from '../../../../shared/bots/bot-chat-tree'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { BotHostReadState } from './use-bot-host-read'

type Tree = {
  chats: BotChatTreeChat[]
  workspaceChats: Record<string, string>
  loadMore: () => void
  state: BotHostReadState
  retry: () => void
}

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  const pending = {
    chats: [],
    workspaceChats: {},
    loadMore: () => {},
    state: 'loading' as const,
    retry: () => {}
  }
  return {
    bots,
    offline: new Set<string>(),
    trees: new Map<string, unknown>(),
    treeListeners: new Set<() => void>(),
    pending
  }
})
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  isHome: (await importOriginal<typeof BotCatalog>()).isHome,
  useBots: () => mocks.bots,
  useBotHomeWorkspaces: () => useAppStore((state) => state.folderWorkspaces),
  useBotWaits: () => [],
  useListedBotItemsNeedingOwner: () => null,
  useBotsEnabled: () => true,
  createBot: vi.fn(),
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  openBotHome: () => true,
  openBotHomeTab: vi.fn()
}))
vi.mock('@/lib/bot-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalogSnapshot>()),
  readBots: () => mocks.bots,
  readBotHostIds: () => ['local'],
  readBotHostState: (hostId: string) => (mocks.offline.has(hostId) ? 'offline' : 'live')
}))
vi.mock('@/lib/bot-host-views', () => ({
  useBotHostOffline: (hostId: string) => mocks.offline.has(hostId)
}))
vi.mock('@/lib/bot-host-kept-homes', () => ({
  withKeptBotHomes: (folders: readonly FolderWorkspace[]) => folders
}))
vi.mock('@/lib/bot-group-catalog', () => ({
  selectActiveBotGroupRoomId: () => null,
  openBotGroup: vi.fn(async () => {})
}))
vi.mock('@/lib/bot-group-list', () => ({
  useBotGroups: () => [],
  refreshBotGroups: vi.fn(async () => {})
}))
vi.mock('@/lib/bot-group-catalog-snapshot', () => ({
  readBotGroups: () => [],
  subscribeToBotGroupChanges: () => () => {}
}))
vi.mock('./use-bot-chat-tree', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void) => {
    mocks.treeListeners.add(listener)
    return () => mocks.treeListeners.delete(listener)
  }
  const useTree = (bot: Bot | null) =>
    useSyncExternalStore(subscribe, () => (bot && mocks.trees.get(bot.id)) ?? mocks.pending)
  return { useBotChatTree: useTree, useBotOwnChatTree: useTree }
})
vi.mock('./NewBotDialog', () => ({ NewBotDialog: () => null }))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import { SidebarBotsSection } from './SidebarBotsSection'

const initialState = useAppStore.getInitialState()

function bot(id: string, name: string, homeId: string, hostId: Bot['hostId'] = 'local'): Bot {
  return {
    id,
    name,
    hostId,
    folder: name.toLowerCase(),
    folderWorkspaceId: homeId,
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

function home(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'bots-group',
    name: id,
    folderPath: `/bots/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function chat(chatId: string, title: string): BotChatTreeChat {
  return {
    chatId,
    title,
    origin: 'side',
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  }
}

function setTree(botId: string, tree: Partial<Tree>): void {
  mocks.trees.set(botId, { ...mocks.pending, state: 'ready', ...tree })
  act(() => mocks.treeListeners.forEach((listener) => listener()))
}

const worker = makeWorktree({
  id: 'repo-1::/fix-login',
  repoId: 'repo-1',
  path: '/fix-login',
  displayName: 'fix-login',
  hostId: 'local'
})

/** Opens a bot's home with `entityId`'s chat tab in front (or a terminal tab). */
function openHome(homeId: string, front: Partial<Tab> = { contentType: 'terminal' }): void {
  const key = folderWorkspaceKey(homeId)
  const tab = makeUnifiedTab({ id: `${homeId}-tab`, worktreeId: key, groupId: 'g', ...front })
  useAppStore.setState({
    activeView: 'terminal',
    activeWorkspaceKey: key,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: 'local',
    unifiedTabsByWorktree: { [key]: [tab] },
    groupsByWorktree: {
      [key]: [makeTabGroup({ id: 'g', worktreeId: key, activeTabId: tab.id, tabOrder: [tab.id] })]
    },
    activeGroupIdByWorktree: { [key]: 'g' }
  })
}

function openWorker(): void {
  useAppStore.setState({
    activeView: 'terminal',
    activeWorkspaceKey: worktreeWorkspaceKey(worker.id),
    activeWorktreeId: worker.id,
    activeWorkspaceExecutionHostId: 'local'
  })
}

/** Runs a few animation frames and any MutationObserver work they queue, on fake timers. */
async function frames(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
  }
}

async function revealCurrent(): Promise<void> {
  act(() => requestScrollToCurrentWorkspaceReveal())
  await frames()
}

function renderSection(): void {
  render(
    <TooltipProvider>
      <SidebarBotsSection onOpenBot={() => {}} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mocks.bots = [bot('bot-1', 'Scout', 'fw-1'), bot('bot-2', 'Pilot', 'fw-2')]
  mocks.offline.clear()
  mocks.trees.clear()
  vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']
  })
  const lineage: WorkspaceLineage = {
    childWorkspaceKey: worktreeWorkspaceKey(worker.id),
    parentWorkspaceKey: folderWorkspaceKey('fw-1'),
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
  useAppStore.setState({
    folderWorkspaces: [home('fw-1'), home('fw-2')],
    worktreesByRepo: { 'repo-1': [worker] },
    workspaceLineageByChildKey: { [lineage.childWorkspaceKey]: lineage },
    hideBotCreatedWorkspaces: true
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('Reveal current in the Bots section', () => {
  it("unfolds a folded Bots section to the bot's row, leaving Projects and the bot fold alone", async () => {
    useAppStore.setState({
      collapsedGroups: new Set([
        BOTS_GROUP_KEY,
        PROJECTS_SECTION_GROUP_KEY,
        getLineageGroupKey('folder:fw-2')
      ])
    })
    openHome('fw-2')
    renderSection()
    expect(document.querySelector('[data-bot-sidebar-entry]')).toBeNull()
    await revealCurrent()
    const folds = useAppStore.getState().collapsedGroups
    expect(folds.has(BOTS_GROUP_KEY)).toBe(false)
    expect(folds.has(PROJECTS_SECTION_GROUP_KEY)).toBe(true)
    // Nothing below the row is wanted, so the bot stays folded.
    expect(folds.has(getLineageGroupKey('folder:fw-2'))).toBe(true)
  })

  it('closes a Bots search whose results hide the list, so the revealed row shows', async () => {
    setTree('bot-1', { chats: [chat('chat-7', 'Fix the login bug')] })
    openHome('fw-1', { contentType: 'agent-session', entityId: 'chat-7' })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Search bots' }))
    // A query for the other bot: its results replace the list the active bot's row is in.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search bots' }), {
      target: { value: 'Pilot' }
    })
    await frames(1)
    const listUnderResults = (): Element | null =>
      document.querySelector('[data-bot-sidebar-list-under-results]')
    expect(listUnderResults()).not.toBeNull()
    await revealCurrent()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(listUnderResults()).toBeNull()
  })

  it('unfolds the bot toward its chat before the chat read lands', async () => {
    useAppStore.setState({ collapsedGroups: new Set([getLineageGroupKey('folder:fw-1')]) })
    openHome('fw-1', { contentType: 'agent-session', entityId: 'chat-7' })
    renderSection()
    await revealCurrent()
    // The chat row mounts only once the read lands; the bot is already open for it.
    expect(useAppStore.getState().collapsedGroups.has(getLineageGroupKey('folder:fw-1'))).toBe(
      false
    )
  })

  it('unfolds nothing under a bot whose server is down', async () => {
    mocks.offline.add('local')
    useAppStore.setState({ collapsedGroups: new Set([getLineageGroupKey('folder:fw-1')]) })
    openHome('fw-1', { contentType: 'agent-session', entityId: 'chat-7' })
    renderSection()
    await revealCurrent()
    expect(useAppStore.getState().collapsedGroups.has(getLineageGroupKey('folder:fw-1'))).toBe(true)
  })

  it('unfolds Bots, the bot and the folded chat a worker workspace sits under', async () => {
    useAppStore.setState({
      collapsedGroups: new Set([BOTS_GROUP_KEY, getLineageGroupKey('folder:fw-1')]),
      botChatFolds: { [botChatFoldKey('local', 'bot-1', 'chat-7')]: 'folded' }
    })
    setTree('bot-1', {
      chats: [chat('chat-7', 'Fix the login bug')],
      workspaceChats: { [worker.id]: 'chat-7' }
    })
    openWorker()
    renderSection()
    await revealCurrent()
    await frames()
    const folds = useAppStore.getState().collapsedGroups
    expect(folds.has(BOTS_GROUP_KEY)).toBe(false)
    expect(folds.has(getLineageGroupKey('folder:fw-1'))).toBe(false)
    expect(useAppStore.getState().botChatFolds[botChatFoldKey('local', 'bot-1', 'chat-7')]).toBe(
      'open'
    )
  })

  it("leaves the worker's cards elsewhere alone when Reveal current renames its Bots line", async () => {
    setTree('bot-1', {
      chats: [chat('chat-7', 'Fix the login bug')],
      workspaceChats: { [worker.id]: 'chat-7' }
    })
    openWorker()
    // The same worker's card in another list at once, as Send to agent forces it into Projects,
    // and a same-id worker's line under a bot on a paired server.
    const twin = { ...worker, hostId: 'ssh:box' as const }
    render(
      <TooltipProvider>
        <SidebarBotsSection onOpenBot={() => {}} />
        <div data-other-list="">
          <WorktreeCard
            worktree={worker}
            repo={undefined}
            isActive
            renameRowKey="repo:repo-1:forced"
          />
          <WorktreeCard
            worktree={twin}
            repo={undefined}
            isActive={false}
            renameRowKey={botWorkerLineRowKey(`ssh:box|${worker.id}`)}
          />
        </div>
      </TooltipProvider>
    )
    await frames()
    const requests: unknown[] = []
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.renamingWorktreeId !== previous.renamingWorktreeId) {
        requests.push(state.renamingWorktreeId)
      }
    })
    act(() => requestScrollToCurrentWorkspaceRevealAndRename())
    await frames(6)
    unsubscribe()
    // The request names the Bots line's own row (host + worktree ID); neither other card edits.
    expect(requests[0]).toEqual({
      worktreeId: worker.id,
      rowKey: botWorkerLineRowKey(`local|${worker.id}`)
    })
    expect(document.querySelector('[data-other-list] input')).toBeNull()
  })
})
