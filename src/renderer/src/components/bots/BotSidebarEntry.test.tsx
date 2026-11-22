// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorktreeStatus } from '../../../../shared/worktree/row-display/worktree-status-rollup'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Bot } from '../../../../shared/bot-types'
import type * as SmartSort from '../../../../shared/sidebar-list/sorting/smart-sort'
import type * as BotHostViews from '@/lib/bot-host-views'
import type { Worktree } from '../../../../shared/worktree/types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { BotChatTree } from './use-bot-chat-tree'
import type * as ChatTree from './use-bot-chat-tree'
import type * as BotHosts from '@/lib/bot-hosts'
import { getLineageGroupKey } from '../../../../shared/sidebar-list/sections/group-keys'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'

const mocks = vi.hoisted(
  (): {
    statusById: Record<string, WorktreeStatus>
    // The PR state each line's own badge would show, by workspace id.
    reviewById: Record<string, string>
    // Stands in for the project list's Smart sort; null keeps the real one.
    smartOrder: string[] | null
    // The bot's server is down.
    offline: boolean
    // The bot's chats read; an older host without it lists the workspaces flat. Null reads from the host.
    chatTree: Pick<BotChatTree, 'state' | 'chats' | 'workspaceChats'> | null
    // The host's answers to `bots.chatTree`, one per read.
    chatTreeReads: Promise<unknown>[]
  } => ({
    statusById: {},
    reviewById: {},
    smartOrder: null,
    offline: false,
    chatTree: { state: 'failed', chats: [], workspaceChats: {} },
    chatTreeReads: []
  })
)

const openBotSession = vi.hoisted(() => vi.fn())
vi.mock('./bot-session-open', () => ({ openBotSession }))

vi.mock('./use-bot-chat-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatTree>()
  return {
    ...actual,
    useBotOwnChatTree: (bot: Bot | null) =>
      mocks.chatTree
        ? { ...mocks.chatTree, loadMore: () => {}, retry: () => {} }
        : actual.useBotOwnChatTree(bot)
  }
})
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: (_bot: unknown, method: string) =>
    method === 'bots.chatTree'
      ? (mocks.chatTreeReads.shift() ?? new Promise(() => {}))
      : Promise.reject(new Error(`unexpected ${method}`))
}))
vi.mock('@/components/sidebar/AttachedWorktreeCards', () => ({
  AttachedWorktreeCards: ({
    roots,
    compactLine
  }: {
    roots: readonly Worktree[]
    compactLine?: boolean
  }) => (
    <ul data-compact-line={compactLine ? 'true' : undefined}>
      {roots.map((worktree) => (
        <li key={worktree.id}>{worktree.displayName}</li>
      ))}
    </ul>
  )
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'inactive'
}))
vi.mock('@/components/sidebar/workspace-card/activity/use-worktree-activity-statuses', () => ({
  useWorktreeActivityStatuses: (ids: readonly string[]) =>
    new Map(ids.map((id) => [id, mocks.statusById[id] ?? 'inactive']))
}))
vi.mock('@/components/sidebar/workspace-card/review/worktree-card-review-resolution', () => ({
  selectWorktreeCardReviewState: (_state: unknown, worktree: { id: string }) =>
    mocks.reviewById[worktree.id] ?? null
}))
vi.mock('../../../../shared/sidebar-list/sorting/smart-sort', async (importOriginal) => {
  const actual = await importOriginal<typeof SmartSort>()
  return {
    ...actual,
    rankWorktreesForSort: (...args: Parameters<typeof actual.rankWorktreesForSort>) => {
      const order = mocks.smartOrder
      return order
        ? {
            sorted: order.flatMap((name) =>
              args[0].worktrees.filter((w) => w.displayName === name)
            ),
            detectedLiveSmartSignal: false
          }
        : actual.rankWorktreesForSort(...args)
    }
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  openBotHome: () => true,
  useBotWaits: () => [],
  useListedBotItemsNeedingOwner: () => null,
  updateBot: vi.fn(),
  deleteBot: vi.fn()
}))
vi.mock('@/lib/bot-host-views', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHostViews>()),
  useBotHostOffline: () => mocks.offline
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import { BotSidebarEntry } from './BotSidebarEntry'

let home = makeFolderWorkspace({ id: 'bot-home' })
let homeSequence = 0
const initialState = useAppStore.getInitialState()

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Scout',
    hostId: 'local',
    folder: 'scout',
    folderWorkspaceId: home.id,
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
    updatedAt: 1,
    ...overrides
  }
}

function worktree(name: string): Worktree {
  return makeWorktree({
    id: `repo-1::/${name}`,
    repoId: 'repo-1',
    path: `/${name}`,
    displayName: name
  })
}

function renderEntry(onOpen: () => void = () => {}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <BotSidebarEntry bot={bot()} home={home} isActive={false} onOpen={onOpen} />
    </TooltipProvider>
  )
}

/** Workspaces under the bot's home by name, each with its status; `cli` ones were linked by hand. */
function seed(entries: Record<string, WorktreeStatus | 'cli'>): void {
  const worktrees = Object.keys(entries).map(worktree)
  mocks.statusById = Object.fromEntries(
    worktrees.flatMap((entry) => {
      const status = entries[entry.displayName]
      return status === 'cli' ? [] : [[entry.id, status]]
    })
  )
  useAppStore.setState({
    collapsedGroups: new Set(),
    // The real toggle also persists; folding is what's under test.
    toggleCollapsedGroup: (key: string) =>
      useAppStore.setState((state) => {
        const next = new Set(state.collapsedGroups)
        if (!next.delete(key)) {
          next.add(key)
        }
        return { collapsedGroups: next }
      }),
    folderWorkspaces: [home],
    worktreesByRepo: { 'repo-1': worktrees },
    worktreeLineageById: {},
    workspaceLineageByChildKey: Object.fromEntries(
      worktrees.map((entry) => [
        worktreeWorkspaceKey(entry.id),
        {
          childWorkspaceKey: worktreeWorkspaceKey(entry.id),
          parentWorkspaceKey: folderWorkspaceKey(home.id),
          origin: entries[entry.displayName] === 'cli' ? 'cli' : 'orchestration',
          capture: { source: 'orchestration-context', confidence: 'explicit' },
          createdAt: 1
        }
      ])
    )
  })
}

function botRow(container: HTMLElement): Element {
  const row = container.querySelector('[data-worktree-card-surface]')
  if (!row) {
    throw new Error('no bot row')
  }
  return row
}

function lines(): string[] {
  return screen.queryAllByRole('listitem').map((item) => item.textContent ?? '')
}

beforeEach(() => {
  home = makeFolderWorkspace({ id: `bot-home-${++homeSequence}` })
  mocks.smartOrder = null
  mocks.offline = false
  mocks.reviewById = {}
  mocks.chatTree = { state: 'failed', chats: [], workspaceChats: {} }
  mocks.chatTreeReads = []
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('BotSidebarEntry', () => {
  it('lists the workspaces under its home on another machine too', () => {
    seed({ 'local-worker': 'done', 'local-by-hand': 'cli' })
    const remote = (name: string): Worktree =>
      makeWorktree({
        id: `win-repo::C:/${name}`,
        repoId: 'win-repo',
        path: `C:/${name}`,
        displayName: name,
        hostId: 'runtime:windows-2',
        runtimeOwnerEnvironmentId: 'windows-2',
        instanceId: `instance-${name}`
      })
    const remoteRows = [remote('remote-worker'), remote('remote-by-hand')]
    const crossStoreRecord = (row: Worktree, origin: 'orchestration' | 'cli') => ({
      childWorkspaceKey: worktreeWorkspaceKey(row.id),
      childInstanceId: row.instanceId,
      parent: {
        installationId: 'this-mac',
        workspaceKey: folderWorkspaceKey(home.id),
        instanceId: home.id
      },
      origin,
      capture: { source: 'orchestration-context', confidence: 'explicit' },
      createdAt: 1
    })
    useAppStore.setState((state) => ({
      worktreesByRepo: { ...state.worktreesByRepo, 'win-repo': remoteRows },
      ownLineageInstallationId: 'this-mac',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only hostDescriptor.installationId from these partial status fixtures.
      runtimeStatusByEnvironmentId: new Map([
        ['windows-2', { status: { hostDescriptor: { installationId: 'windows-2-install' } } }]
      ]) as unknown as typeof state.runtimeStatusByEnvironmentId,
      crossStoreLineageByStoreKey: {
        'windows-2': {
          [worktreeWorkspaceKey(remoteRows[0].id)]: crossStoreRecord(
            remoteRows[0],
            'orchestration'
          ),
          [worktreeWorkspaceKey(remoteRows[1].id)]: crossStoreRecord(remoteRows[1], 'cli')
        }
      }
    }))
    renderEntry()

    expect(lines().toSorted()).toEqual([
      'local-by-hand',
      'local-worker',
      'remote-by-hand',
      'remote-worker'
    ])
  })

  it('orders the lines by the Smart sort', () => {
    seed({ first: 'done', second: 'working', third: 'permission' })
    mocks.smartOrder = ['third', 'second', 'first']
    renderEntry()

    expect(lines()).toEqual(['third', 'second', 'first'])
  })

  it('hides workspaces on the collapsed row and restores its rows on unfold', () => {
    seed({ ask: 'permission', run: 'working', run2: 'working', broke: 'failed', ok: 'done' })
    renderEntry()

    const fold = screen.getByRole('button', { name: 'Fold Scout' })
    expect(fold.textContent).toBe('')
    fireEvent.click(fold)
    expect(lines()).toEqual([])
    // Folded, it shows only its most urgent workspace's status, not a count of every one.
    const toggle = screen.getByRole('button', { name: 'Unfold Scout' })
    expect(toggle.textContent).toBe('')

    fireEvent.click(toggle)
    expect(lines()).toHaveLength(5)
  })

  it('lists workspaces whose PR merged or closed with the rest, with no done fold', () => {
    seed({ open: 'done', merged: 'done', closed: 'inactive' })
    mocks.reviewById = {
      [worktree('merged').id]: 'merged',
      [worktree('closed').id]: 'closed'
    }
    renderEntry()

    expect(lines()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: /done/ })).toBeNull()
  })

  it('pages workspaces in place and keeps the open workspace past the cap', () => {
    const names = Array.from({ length: 10 }, (_, index) => `ws-${index}`)
    seed(Object.fromEntries(names.map((name) => [name, 'done'])))
    mocks.smartOrder = names
    useAppStore.setState({ activeWorktreeId: worktree('ws-9').id })
    renderEntry()

    expect(lines()).toEqual([...names.slice(0, 8), 'ws-9'])
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))
    expect(lines()).toEqual(names)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(lines()).toEqual([...names.slice(0, 8), 'ws-9'])
  })

  it('opens a bot with its chats folded: nothing until the first read, then the last tree at once', async () => {
    seed({ 'fix-flash': 'working' })
    useAppStore.setState({
      collapsedGroups: new Set([getLineageGroupKey(folderWorkspaceKey(home.id))])
    })
    const chat: BotChatTreeChat = {
      chatId: 'chat-1',
      title: 'Fix the flash',
      origin: 'side',
      live: 'idle',
      lastActiveAt: 0,
      unread: false,
      closed: false,
      tab: true,
      running: [],
      runningTotal: 1,
      finished: [],
      finishedTotal: 0,
      failedTotal: 0
    }
    let land: (tree: unknown) => void = () => {}
    mocks.chatTree = null
    mocks.chatTreeReads = [new Promise((resolve) => (land = resolve))]
    renderEntry()

    fireEvent.click(screen.getByRole('button', { name: 'Unfold Scout' }))
    expect(lines()).toEqual([])
    expect(screen.queryByText('Fix the flash')).toBeNull()
    await act(async () => {
      land({ chats: [chat], workspaceChats: { [worktree('fix-flash').id]: 'chat-1' } })
    })
    expect(screen.getByText('Fix the flash')).toBeTruthy()
    expect(lines()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))
    expect(screen.queryByText('Fix the flash')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unfold Scout' }))
    expect(screen.getByText('Fix the flash')).toBeTruthy()
    expect(lines()).toEqual([])
  })

  it('switches chats from their sidebar rows, flashing the front one, and folds only from the chevron', () => {
    seed({ 'front-work': 'working', 'background-work': 'working' })
    const workspace = folderWorkspaceKey(home.id)
    const groupId = 'group-1'
    const tabs = ['front', 'background'].map((id) =>
      makeUnifiedTab({ id, worktreeId: workspace, groupId, contentType: 'agent-session' })
    )
    useAppStore.setState({
      activeView: 'terminal',
      activeWorkspaceKey: workspace,
      activeGroupIdByWorktree: { [workspace]: groupId },
      groupsByWorktree: {
        [workspace]: [
          makeTabGroup({
            id: groupId,
            worktreeId: workspace,
            activeTabId: 'front',
            tabOrder: ['front', 'background']
          })
        ]
      },
      unifiedTabsByWorktree: { [workspace]: tabs }
    })
    mocks.chatTree = {
      state: 'ready',
      workspaceChats: {
        [worktree('front-work').id]: 'front',
        [worktree('background-work').id]: 'background'
      },
      chats: tabs.map(({ entityId }) => ({
        chatId: entityId,
        title: entityId,
        origin: 'side',
        live: 'idle',
        lastActiveAt: 0,
        unread: false,
        closed: false,
        tab: true,
        running: [],
        runningTotal: 0,
        finished: [],
        finishedTotal: 0,
        failedTotal: 0
      }))
    }
    openBotSession.mockClear()
    vi.stubGlobal('api', { ui: { set: vi.fn().mockResolvedValue(undefined) } })
    // The chats' panes on the right, as their overlays mount them.
    const [frontPane, backgroundPane] = tabs.map(({ id }) => {
      const pane = document.createElement('div')
      pane.setAttribute('data-structured-agent-session-overlay-tab-id', id)
      document.body.append(pane)
      return pane
    })
    const flashed = (pane: HTMLElement): boolean => pane.classList.contains('pane-focus-rim-flash')
    try {
      renderEntry()
      const front = screen.getByRole('button', { name: /^front · Side chat/ })
      const background = screen.getByRole('button', { name: /^background · Side chat/ })
      expect(front.getAttribute('aria-current')).toBe('true')
      expect(background.hasAttribute('aria-current')).toBe(false)

      // A press only switches chats, the front one included; its workers stay as they were.
      const frontFold = front.getAttribute('aria-expanded')
      fireEvent.click(front, { detail: 1 })
      expect(front.getAttribute('aria-expanded')).toBe(frontFold)
      expect(openBotSession).toHaveBeenCalledExactlyOnceWith(bot(), 'front')
      // The press on the chat already in front also flashes its pane, as other jumps to an open pane do.
      expect(flashed(frontPane)).toBe(true)
      frontPane.classList.remove('pane-focus-rim-flash')
      fireEvent.click(front, { detail: 2 })
      fireEvent.keyDown(front, { key: 'Enter', repeat: true })
      expect(openBotSession).toHaveBeenCalledOnce()
      expect(flashed(frontPane)).toBe(false)

      const backgroundFold = background.getAttribute('aria-expanded')
      fireEvent.click(background, { detail: 1 })
      expect(openBotSession).toHaveBeenLastCalledWith(bot(), 'background')
      expect(background.getAttribute('aria-expanded')).toBe(backgroundFold)

      // Only the chevron shows its workers.
      fireEvent.click(screen.getByRole('button', { name: 'Unfold background' }))
      expect(background.getAttribute('aria-expanded')).toBe('true')
      expect(flashed(backgroundPane)).toBe(false)
    } finally {
      frontPane.remove()
      backgroundPane.remove()
      vi.unstubAllGlobals()
    }
  })

  it('lists nothing under a bot whose server is down, and gives it no fold', () => {
    seed({ ws: 'working', done: 'done' })
    mocks.offline = true
    renderEntry()

    expect(lines()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Fold Scout' })).toBeNull()
  })

  it('opens the bot from its row, name or Enter and folds only from the chevron', () => {
    seed({ first: 'done', second: 'done' })
    useAppStore.setState({
      activeView: 'terminal',
      collapsedGroups: new Set([getLineageGroupKey(folderWorkspaceKey(home.id))])
    })
    const onOpen = vi.fn()
    const { container } = renderEntry(onOpen)
    const title = screen.getByText('Scout')

    fireEvent.click(botRow(container), { detail: 1 })
    fireEvent.click(title, { detail: 1 })
    fireEvent.keyDown(title, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(3)
    expect(lines()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'Unfold Scout' }))
    expect(lines()).toHaveLength(2)
    fireEvent.click(botRow(container), { detail: 1 })
    expect(lines()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))
    expect(lines()).toEqual([])
  })

  it("ignores a double-click's second click and a held key's repeats", () => {
    seed({ first: 'done', second: 'done' })
    const onOpen = vi.fn()
    renderEntry(onOpen)
    const title = screen.getByText('Scout')

    fireEvent.click(title, { detail: 2 })
    fireEvent.keyDown(title, { key: 'Enter', repeat: true })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('unfolds a folded bot when one of its workspaces opens', () => {
    seed({ first: 'done', second: 'done' })
    renderEntry()
    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))
    expect(lines()).toEqual([])

    act(() => useAppStore.setState({ activeWorktreeId: worktree('second').id }))
    expect(lines()).toHaveLength(2)
  })

  it('keeps a fold the owner chose when its row shows again with the same workspace open', () => {
    seed({ first: 'done', second: 'done' })
    useAppStore.setState({ activeWorktreeId: worktree('second').id })
    const { unmount } = renderEntry()
    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))
    expect(lines()).toEqual([])

    // Search or the section's fold hides the row and shows it again: nothing was navigated.
    unmount()
    renderEntry()
    expect(lines()).toEqual([])

    // Opening another of its workspaces still unfolds it.
    act(() => useAppStore.setState({ activeWorktreeId: worktree('first').id }))
    expect(lines()).toHaveLength(2)
  })

  it('unfolds for the open workspace when Hide bot workspaces turns on and it is listed only here', () => {
    seed({ first: 'done', second: 'done' })
    useAppStore.setState({
      hideBotCreatedWorkspaces: false,
      activeWorktreeId: worktree('second').id
    })
    renderEntry()
    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))
    expect(lines()).toEqual([])

    act(() => useAppStore.setState({ hideBotCreatedWorkspaces: true }))
    expect(lines()).toHaveLength(2)
  })

  it('stays folded when one of its workspaces opens from its project, under Hide bot workspaces off', () => {
    seed({ first: 'done', second: 'done' })
    useAppStore.setState({ hideBotCreatedWorkspaces: false })
    renderEntry()
    fireEvent.click(screen.getByRole('button', { name: 'Fold Scout' }))

    act(() => useAppStore.setState({ activeWorktreeId: worktree('second').id }))
    expect(lines()).toEqual([])
  })
})
