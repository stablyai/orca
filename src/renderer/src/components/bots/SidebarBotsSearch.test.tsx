// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as BotCatalog from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { Worktree } from '../../../../shared/worktree/types'

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  const groups: BotGroup[] = []
  return {
    bots,
    groups,
    rpc: vi.fn(async (_target: unknown, method: string, _params?: unknown) =>
      method === 'bots.chatTree' ? { chats: [], workspaceChats: {} } : {}
    ),
    activate: vi.fn(),
    onOpenBot: vi.fn(),
    updateBot: vi.fn(async (_bot: { id: string }, _updates: unknown) => ({})),
    openGroup: vi.fn(async (_group: unknown) => {}),
    toastError: vi.fn()
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
  updateBot: (bot: { id: string }, updates: unknown) => mocks.updateBot(bot, updates),
  deleteBot: vi.fn(),
  openBotHome: (...args: unknown[]) => {
    mocks.activate(...args)
    return true
  }
}))

vi.mock('@/lib/bot-group-catalog', () => ({
  selectActiveBotGroupRoomId: () => null,
  openBotGroup: (group: unknown) => mocks.openGroup(group)
}))
vi.mock('@/lib/bot-group-list', () => ({
  useBotGroups: () => mocks.groups,
  refreshBotGroups: vi.fn(async () => {})
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    mocks.rpc(target, method, params)
}))

vi.mock('sonner', () => ({ toast: { error: (message: string) => mocks.toastError(message) } }))
vi.mock('@/components/sidebar/AttachedWorktreeCards', () => ({
  AttachedWorktreeCards: ({ roots }: { roots: readonly Worktree[] }) => (
    <ul>
      {roots.map((root) => (
        <li key={root.id}>{root.displayName}</li>
      ))}
    </ul>
  )
}))

vi.mock('./NewBotDialog', () => ({
  NewBotDialog: ({ open }: { open: boolean }) => (open ? <div data-new-bot-dialog /> : null)
}))

vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import { SidebarBotsSection } from './SidebarBotsSection'
import { setBotPurpose } from './bot-purpose-cache'

const initialState = useAppStore.getInitialState()

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    name: 'Reviewer',
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: 'fw-1',
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

function home(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'bots-group',
    name: 'Reviewer',
    folderPath: '/home/me/.orca/bots/reviewer',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function group(overrides: Partial<BotGroup> = {}): BotGroup {
  return {
    id: 'group-1',
    name: 'Crew',
    hostId: 'local',
    revision: 1,
    folder: 'group-crew',
    folderWorkspaceId: 'fw-g',
    createdAt: 1,
    members: [
      { botId: 'bot-1', sessionId: 'bot-group-member-1' },
      { botId: 'bot-2', sessionId: 'bot-group-member-2' }
    ],
    replyMode: { kind: 'mentions' },
    ...overrides
  }
}

function threeBots(): void {
  mocks.bots = [
    bot(),
    bot({ id: 'bot-2', name: 'Scout', folderWorkspaceId: 'fw-2' }),
    bot({ id: 'bot-3', name: 'Disk Space', folderWorkspaceId: 'fw-3' })
  ]
  useAppStore.setState({
    folderWorkspaces: [home(), home({ id: 'fw-2' }), home({ id: 'fw-3' })]
  })
}

function botWorkspaces(): void {
  const first = makeWorktree({
    id: 'repo::/first',
    repoId: 'repo',
    path: '/first',
    displayName: 'First worker'
  })
  const second = makeWorktree({
    id: 'repo::/second',
    repoId: 'repo',
    path: '/second',
    displayName: 'Second worker'
  })
  useAppStore.setState({
    worktreesByRepo: { repo: [first, second] },
    workspaceLineageByChildKey: {
      'worktree:repo::/first': {
        childWorkspaceKey: 'worktree:repo::/first',
        parentWorkspaceKey: 'folder:fw-1',
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'explicit' },
        createdAt: 1
      },
      'worktree:repo::/second': {
        childWorkspaceKey: 'worktree:repo::/second',
        parentWorkspaceKey: 'folder:fw-2',
        origin: 'orchestration',
        capture: { source: 'orchestration-context', confidence: 'explicit' },
        createdAt: 1
      }
    }
  })
}

function renderSection(): void {
  render(
    <TooltipProvider>
      <SidebarBotsSection onOpenBot={mocks.onOpenBot} />
    </TooltipProvider>
  )
}

function renderStrictSection(): void {
  render(
    <StrictMode>
      <TooltipProvider>
        <SidebarBotsSection onOpenBot={mocks.onOpenBot} />
      </TooltipProvider>
    </StrictMode>
  )
}

/** Holds animation frames until the returned flush, to catch a reveal that runs late. */
function queueFrames(): () => void {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  return () =>
    act(() => {
      for (const frame of frames.splice(0)) {
        frame(0)
      }
    })
}

function withCrew(): void {
  threeBots()
  mocks.groups = [group()]
  useAppStore.setState({
    folderWorkspaces: [...useAppStore.getState().folderWorkspaces, home({ id: 'fw-g' })]
  })
}

/** Holds the next group open until the returned call. */
function deferGroupOpen(): () => void {
  let finish: () => void = () => {}
  mocks.openGroup.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
  return () => finish()
}

/** Two bots folded before this start; `prefix` keeps each test's bots apart in module memory. */
function twoFoldedBots(prefix: string): void {
  mocks.bots = [
    bot({ id: `${prefix}-1`, name: 'First folded bot', folderWorkspaceId: `${prefix}-fw-1` }),
    bot({ id: `${prefix}-2`, name: 'Second folded bot', folderWorkspaceId: `${prefix}-fw-2` })
  ]
  useAppStore.setState({
    folderWorkspaces: [home({ id: `${prefix}-fw-1` }), home({ id: `${prefix}-fw-2` })],
    collapsedGroups: new Set([`lineage:folder:${prefix}-fw-1`, `lineage:folder:${prefix}-fw-2`])
  })
}

function foldButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^(Fold|Unfold) ${name}$`) })
}

function searchToggle(): HTMLElement {
  return screen.getByRole('button', { name: 'Search bots' })
}

function openSearch(): HTMLInputElement {
  fireEvent.click(searchToggle())
  const field = screen.getByRole('searchbox', { name: 'Search bots' })
  if (!(field instanceof HTMLInputElement)) {
    throw new Error('no search field')
  }
  return field
}

function type(field: HTMLInputElement, value: string): void {
  fireEvent.change(field, { target: { value } })
}

function results(): string[] {
  return [...document.querySelectorAll('[data-bot-search-result]')].map(
    (row) => row.getAttribute('data-bot-search-result')?.replace(/^local\//, '') ?? ''
  )
}

function rowTitle(botId: string): HTMLElement {
  const title = document.querySelector<HTMLElement>(
    `[data-bot-sidebar-entry="local/${botId}"] [data-worktree-title-inline-rename]`
  )
  if (!title) {
    throw new Error(`no row title for ${botId}`)
  }
  return title
}

beforeEach(() => {
  mocks.bots = []
  mocks.groups = []
  mocks.activate.mockReset()
  mocks.onOpenBot.mockReset()
  mocks.openGroup.mockReset()
  mocks.openGroup.mockImplementation(async () => {})
  mocks.toastError.mockReset()
  vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('Bots search', () => {
  it('mounts no search field until the toggle opens it, and focuses the field', () => {
    threeBots()
    renderSection()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false')
    const field = openSearch()
    expect(document.activeElement).toBe(field)
    expect(searchToggle().getAttribute('aria-expanded')).toBe('true')
  })

  it('finds a bot by its purpose after its row has read it, listing name matches first', () => {
    threeBots()
    renderSection()
    act(() => setBotPurpose('local/bot-3', 'Watches the disk and reviews cleanup'))
    const field = openSearch()
    type(field, 'review')
    expect(results()).toEqual(['bot-1', 'bot-3'])
    expect(document.querySelector('[data-bot-search-result="local/bot-3"] mark')?.textContent).toBe(
      'review'
    )
    // A purpose that arrives while searching joins the results.
    act(() => setBotPurpose('local/bot-2', 'Reviews pull requests'))
    expect(results()).toEqual(['bot-1', 'bot-2', 'bot-3'])
    act(() => setBotPurpose('local/bot-2', 'Writes docs'))
    expect(results()).toEqual(['bot-1', 'bot-3'])
    act(() => setBotPurpose('local/bot-3', null))
    expect(results()).toEqual(['bot-1'])
  })

  it('hides drag handles while open', () => {
    threeBots()
    renderSection()
    expect(document.querySelector('[data-project-group-header-drag-handle]')).toBeTruthy()
    openSearch()
    expect(document.querySelector('[data-project-group-header-drag-handle]')).toBeNull()
  })

  it('opens the first result on Enter and focuses its row under StrictMode', async () => {
    threeBots()
    renderStrictSection()
    const field = openSearch()
    type(field, 'disk')
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-3' }))
    expect(mocks.onOpenBot).toHaveBeenCalledOnce()
    expect(screen.queryByRole('searchbox')).toBeNull()
    await vi.waitFor(() => expect(document.activeElement).toBe(rowTitle('bot-3')))
  })

  it('keeps newer focus in a reopened search after a selection', () => {
    threeBots()
    renderSection()
    const field = openSearch()
    type(field, 'scout')
    const flushFrames = queueFrames()
    fireEvent.keyDown(field, { key: 'Enter' })
    const reopened = openSearch()
    reopened.focus()
    flushFrames()
    expect(document.activeElement).toBe(reopened)
  })

  it('keeps newer focus on another control after a selection', () => {
    threeBots()
    renderSection()
    const field = openSearch()
    type(field, 'scout')
    const flushFrames = queueFrames()
    fireEvent.keyDown(field, { key: 'Enter' })
    searchToggle().focus()
    flushFrames()
    expect(document.activeElement).toBe(searchToggle())
  })

  it('ignores Enter and Esc while an IME is composing', () => {
    threeBots()
    renderSection()
    const field = openSearch()
    type(field, 'sc')
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(screen.getByRole('searchbox')).toBeTruthy()
  })

  it('closes on Esc without letting it reach anything else, and returns focus to the toggle', () => {
    threeBots()
    renderSection()
    const outer = vi.fn()
    document.addEventListener('keydown', outer)
    const field = openSearch()
    type(field, 'sc')
    fireEvent.keyDown(field, { key: 'Escape' })
    document.removeEventListener('keydown', outer)
    expect(outer).not.toHaveBeenCalled()
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(searchToggle())
    // Opening again starts empty.
    expect(openSearch().value).toBe('')
  })

  it('stays open when focus or a click leaves the field', () => {
    threeBots()
    renderSection()
    const field = openSearch()
    fireEvent.blur(field)
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(screen.getByRole('searchbox')).toBeTruthy()
  })

  it('cancels an empty search from an ordinary row without propagating Esc', () => {
    threeBots()
    renderSection()
    openSearch()
    const title = rowTitle('bot-1')
    title.focus()
    fireEvent.keyDown(title, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('searchbox')).toBeTruthy()
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    fireEvent.keyDown(title, { key: 'Escape' })
    document.removeEventListener('keydown', outside)
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(searchToggle())
    expect(outside).not.toHaveBeenCalled()
  })

  it('shows a folded section while open, and folds it back when cancelled', () => {
    threeBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()
    expect(screen.queryByText('Scout')).toBeNull()
    openSearch()
    expect(screen.getByText('Scout')).toBeTruthy()
    // Tab from the field reaches a real row, which stays.
    rowTitle('bot-1').focus()
    expect(document.activeElement).toBe(rowTitle('bot-1'))
    fireEvent.click(searchToggle())
    expect(screen.queryByText('Scout')).toBeNull()
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
  })

  it('unfolds a folded section for good when a result opens, and focuses its row', async () => {
    threeBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()
    const field = openSearch()
    type(field, 'scout')
    fireEvent.click(document.querySelector('[data-bot-search-result="local/bot-2"]')!)
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)
    await vi.waitFor(() => expect(document.activeElement).toBe(rowTitle('bot-2')))
  })

  it('tells about paused bots the list hides, and shows them on request', () => {
    mocks.bots = [
      bot(),
      bot({ id: 'bot-2', name: 'Sleepy', folderWorkspaceId: 'fw-2', paused: true })
    ]
    useAppStore.setState({
      folderWorkspaces: [home(), home({ id: 'fw-2' })],
      botSidebarView: { sortBy: 'manual', hidePausedBots: true, hideSleepingWorkers: false }
    })
    renderSection()
    const field = openSearch()
    type(field, 'sleep')
    expect(results()).toEqual([])
    expect(screen.getByText('1 paused match')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show paused bots' }))
    expect(useAppStore.getState().botSidebarView.hidePausedBots).toBe(false)
    expect(results()).toEqual(['bot-2'])
    // Paused is said in words, not only by dimming.
    expect(
      screen.getByRole('button', { name: /Paused$/ }).getAttribute('data-bot-search-result')
    ).toBe('local/bot-2')
  })

  it('focuses the group row when a group finishes opening under StrictMode', async () => {
    withCrew()
    const finish = deferGroupOpen()
    renderStrictSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    await act(async () => finish())
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(document.activeElement).toBe(rowTitle('group-1'))
    expect(mocks.onOpenBot).toHaveBeenCalledOnce()
  })

  it('leaves the search alone when focus moves away while a group opens', async () => {
    withCrew()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    const finish = deferGroupOpen()
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    const options = screen.getByRole('button', { name: 'Bot options' })
    act(() => options.focus())
    await act(async () => finish())
    expect(document.activeElement).toBe(options)
    expect(screen.getByRole('searchbox')).toBe(field)
    expect(field.value).toBe('crew')
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
    expect(mocks.onOpenBot).not.toHaveBeenCalled()
  })

  it('leaves the search alone when focus leaves and comes back while a group opens', async () => {
    withCrew()
    const finish = deferGroupOpen()
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    act(() => screen.getByRole('button', { name: 'Bot options' }).focus())
    act(() => field.focus())
    await act(async () => finish())
    expect(document.activeElement).toBe(field)
    expect(screen.getByRole('searchbox')).toBe(field)
    expect(mocks.onOpenBot).not.toHaveBeenCalled()
  })

  it('ignores a group that opens after its last bot went away and came back', async () => {
    withCrew()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    const finish = deferGroupOpen()
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    const homes = useAppStore.getState().folderWorkspaces
    act(() => useAppStore.setState({ folderWorkspaces: [] }))
    act(() => useAppStore.setState({ folderWorkspaces: homes }))
    await act(async () => finish())
    expect(mocks.onOpenBot).not.toHaveBeenCalled()
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
  })

  it('says nothing when a group fails to open after the search was closed', async () => {
    withCrew()
    let fail: () => void = () => {}
    mocks.openGroup.mockImplementation(
      () => new Promise<void>((_resolve, reject) => (fail = () => reject(new Error('gone'))))
    )
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Escape' })
    await act(async () => fail())
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('keeps the search where the user typed when a group opens after the query changed', async () => {
    threeBots()
    mocks.groups = [group()]
    useAppStore.setState({
      folderWorkspaces: [...useAppStore.getState().folderWorkspaces, home({ id: 'fw-g' })]
    })
    let finish: () => void = () => {}
    mocks.openGroup.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    type(field, 'scout')
    await act(async () => finish())
    expect(screen.getByRole('searchbox')).toBe(field)
    expect(field.value).toBe('scout')
    expect(document.activeElement).toBe(field)
    expect(results()).toEqual(['bot-2'])
  })

  it('closes when its last bot goes away, and stays closed when bots come back', () => {
    threeBots()
    renderSection()
    openSearch()
    const homes = useAppStore.getState().folderWorkspaces
    act(() => useAppStore.setState({ folderWorkspaces: [] }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    act(() => useAppStore.setState({ folderWorkspaces: homes }))
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(searchToggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the search and its text when a group fails to open', async () => {
    threeBots()
    mocks.groups = [group()]
    useAppStore.setState({
      folderWorkspaces: [...useAppStore.getState().folderWorkspaces, home({ id: 'fw-g' })]
    })
    mocks.openGroup.mockImplementation(async () => {
      throw new Error('The room is gone')
    })
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Something went wrong. Try again.')
    )
    expect(field.value).toBe('crew')
    expect(screen.getByRole('searchbox')).toBe(field)
    expect(mocks.onOpenBot).not.toHaveBeenCalled()
  })

  it('leaves the search alone when a group opens after the search was closed', async () => {
    threeBots()
    mocks.groups = [group()]
    useAppStore.setState({
      collapsedGroups: new Set(['bots']),
      folderWorkspaces: [...useAppStore.getState().folderWorkspaces, home({ id: 'fw-g' })]
    })
    let finish: () => void = () => {}
    mocks.openGroup.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)))
    renderSection()
    const field = openSearch()
    type(field, 'crew')
    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Escape' })
    await act(async () => finish())
    // The underlying room open cannot be cancelled; its stale callback leaves the current view alone.
    expect(mocks.onOpenBot).not.toHaveBeenCalled()
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
  })
})

describe('Collapse all bots', () => {
  it('expands every persisted fold on a cold start from the header', () => {
    twoFoldedBots('cold-header')
    renderSection()
    expect(foldButton('First folded bot').getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Expand all bots' }))
    expect(foldButton('First folded bot').getAttribute('aria-expanded')).toBe('true')
    expect(foldButton('Second folded bot').getAttribute('aria-expanded')).toBe('true')
  })

  it('expands every persisted fold on a cold start from Bot options', async () => {
    twoFoldedBots('cold-menu')
    renderSection()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Bot options' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Expand all bots' }))
    expect(foldButton('First folded bot').getAttribute('aria-expanded')).toBe('true')
    expect(foldButton('Second folded bot').getAttribute('aria-expanded')).toBe('true')
  })

  it('expands the folds of paused bots the list hides too', () => {
    twoFoldedBots('hidden-paused')
    mocks.bots = [mocks.bots[0]!, { ...mocks.bots[1]!, paused: true }]
    useAppStore.setState({
      botSidebarView: { sortBy: 'manual', hidePausedBots: true, hideSleepingWorkers: false }
    })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all bots' }))
    expect(useAppStore.getState().collapsedGroups.has('lineage:folder:hidden-paused-fw-2')).toBe(
      false
    )
  })

  it('folds every bot and back from the header, and hides while searching', () => {
    threeBots()
    botWorkspaces()
    renderSection()
    expect(screen.getByText('First worker')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all bots' }))
    expect(screen.queryByText('First worker')).toBeNull()
    expect(screen.queryByText('Second worker')).toBeNull()
    // Rows stay; the section fold is a separate control.
    expect(screen.getByText('Scout')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all bots' }))
    expect(screen.getByText('First worker')).toBeTruthy()
    expect(screen.getByText('Second worker')).toBeTruthy()
    openSearch()
    expect(screen.queryByRole('button', { name: 'Collapse all bots' })).toBeNull()
  })

  it('offers no collapse action when the bots have no children', () => {
    threeBots()
    renderSection()
    expect(screen.queryByRole('button', { name: 'Collapse all bots' })).toBeNull()
  })
})
