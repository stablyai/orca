// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as BotCatalog from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  const groups: BotGroup[] = []
  return {
    bots,
    groups,
    rpc: vi.fn(async (_target: unknown, _method: string, _params?: unknown) => ({})),
    activate: vi.fn(),
    openHomeTab: vi.fn(async (_bot: Bot) => true),
    onOpenBot: vi.fn(),
    updateBot: vi.fn(async (_bot: { id: string }, _updates: unknown) => ({}))
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
  openBotHomeTab: (bot: Bot) => mocks.openHomeTab(bot),
  openBotHome: (...args: unknown[]) => {
    mocks.activate(...args)
    return true
  }
}))

vi.mock('@/lib/bot-group-catalog', () => ({
  selectActiveBotGroupRoomId: () => null,
  openBotGroup: vi.fn(async () => {})
}))
vi.mock('@/lib/bot-group-list', () => ({
  useBotGroups: () => mocks.groups,
  refreshBotGroups: vi.fn(async () => {})
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: unknown, method: string, params?: unknown) =>
    mocks.rpc(target, method, params)
}))

vi.mock('./NewBotDialog', () => ({
  NewBotDialog: ({ open }: { open: boolean }) => (open ? <div data-new-bot-dialog /> : null)
}))

vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import { SidebarBotsSection } from './SidebarBotsSection'

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

// Rows are keyed by host and id; these tests list this computer's bots only.
function rowIds(): (string | null)[] {
  return [...document.querySelectorAll('[data-project-group-header-id]')].map(
    (entry) => entry.getAttribute('data-project-group-header-id')?.replace(/^local\//, '') ?? null
  )
}

/** Each bot entry 40 px tall, from the top of a list at y = 0. */
function stubRowRects(): void {
  const entries = [...document.querySelectorAll<HTMLElement>('[data-project-group-header-id]')]
  for (const [index, entry] of entries.entries()) {
    entry.getBoundingClientRect = () => new DOMRect(0, index * 40, 200, 40)
  }
  const list = document.querySelector<HTMLElement>('[data-bot-sidebar-list]')
  if (list) {
    list.getBoundingClientRect = () => new DOMRect(0, 0, 200, 400)
    Object.defineProperty(list, 'scrollHeight', { value: entries.length * 40 })
  }
}

/** Reviewer's row, at the top, dragged below Jelly's. */
function dragReviewerBelowJelly(): void {
  fireEvent.pointerDown(screen.getByText('Reviewer'), {
    pointerId: 1,
    button: 0,
    clientX: 20,
    clientY: 10
  })
  for (const clientY of [30, 115]) {
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY, buttons: 1 })
    )
  }
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 20, clientY: 115 }))
}

function threeUnplacedBots(): void {
  mocks.bots = [
    bot(),
    bot({ id: 'bot-2', name: 'Scout', folderWorkspaceId: 'fw-2' }),
    bot({ id: 'bot-3', name: 'Jelly', folderWorkspaceId: 'fw-3' })
  ]
  useAppStore.setState({
    folderWorkspaces: [home(), home({ id: 'fw-2' }), home({ id: 'fw-3' })]
  })
}

function renderSection(): void {
  render(
    <TooltipProvider>
      <SidebarBotsSection onOpenBot={mocks.onOpenBot} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mocks.bots = []
  mocks.groups = []
  mocks.rpc.mockClear()
  mocks.activate.mockReset()
  mocks.openHomeTab.mockClear()
  mocks.onOpenBot.mockReset()
  mocks.updateBot.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('SidebarBotsSection', () => {
  it('omits a row whose home is not loaded', () => {
    mocks.bots = [bot(), bot({ id: 'bot-2', name: 'Scout', folderWorkspaceId: 'fw-missing' })]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    expect(screen.getByText('Reviewer')).toBeTruthy()
    expect(screen.queryByText('Scout')).toBeNull()
  })

  it('toggles rows from the header and preserves focus for keyboard activation', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    const header = screen.getByRole('button', { name: /^Collapse Bots,/ })
    // Held focus would keep the folded faces spread after the pointer leaves.
    header.focus()
    fireEvent.click(header, { detail: 1 })
    expect(document.activeElement).not.toBe(header)
    expect(screen.queryByText('Reviewer')).toBeNull()
    header.focus()
    fireEvent.click(header, { detail: 0 })
    expect(document.activeElement).toBe(header)
    expect(screen.getByText('Reviewer')).toBeTruthy()
  })

  it('opens the selected chat from its face while only the header expands the section', async () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    // Room for all three faces.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(
          private readonly callback: (
            entries: { target: Element; contentRect: { width: number } }[]
          ) => void
        ) {}
        observe(target: Element): void {
          this.callback([{ target, contentRect: { width: 68 } }])
        }
        unobserve(): void {}
        disconnect(): void {}
      }
    )
    threeUnplacedBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()

    const face = screen.getByRole('button', { name: /^Scout\b/ })
    const header = screen.getByRole('button', { name: /^Expand Bots,/ })
    fireEvent.click(face)
    await waitFor(() => expect(mocks.onOpenBot).toHaveBeenCalledOnce())
    expect(mocks.openHomeTab).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-2' }))
    expect(header.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(mocks.openHomeTab).toHaveBeenCalledOnce()
  })

  it('folds open from the "+N" circle', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    threeUnplacedBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more bots' }))
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)
    expect(mocks.openHomeTab).not.toHaveBeenCalled()
  })

  it('leaves the folded header without its controls, so Tab cannot reach them', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    threeUnplacedBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()
    const controls = (): (HTMLElement | null)[] => [
      screen.queryByRole('button', { name: 'Search bots' }),
      screen.queryByRole('button', { name: /^Bot options/ }),
      screen.queryByRole('button', { name: 'New bot or group' })
    ]
    expect(controls()).toEqual([null, null, null])
    // The fold button and the faces stay; the folded summary still counts the rest.
    expect(screen.getByRole('button', { name: /^Expand Bots,/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show 3 more bots' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Expand Bots,/ }))
    expect(controls().every(Boolean)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Collapse Bots,/ }))
    expect(controls()).toEqual([null, null, null])
  })

  it('keeps the + menu shut on unfold after a fold it never saw', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New bot or group' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'New bot' })).toBeTruthy()
    // A store write folds the section without the menu's own dismissal.
    act(() => useAppStore.getState().toggleCollapsedGroup('bots'))
    act(() => useAppStore.getState().toggleCollapsedGroup('bots'))
    expect(screen.getByRole('button', { name: 'New bot or group' })).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'New bot' })).toBeNull()
  })

  it('keeps New bot access while empty and folds the onboarding card away', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    renderSection()
    expect(screen.getByText('Bots')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New bot' })).toBeTruthy()
    // No count beside the title while there is nothing to count.
    expect(screen.queryByText('0')).toBeNull()
    const emptyHeader = screen.getByRole('button', { name: /^Collapse Bots, 0 bots/ })
    expect(emptyHeader.hasAttribute('disabled')).toBe(false)
    fireEvent.click(emptyHeader)
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
    expect(screen.queryByText('Your AI teammate')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand Bots, 0 bots/ }))
    expect(screen.getByText('Your AI teammate')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New bot or group' }), { key: 'Enter' })
    expect(screen.getByRole('menuitem', { name: 'New bot' })).toBeTruthy()
    // A group needs two bots.
    expect(
      screen.getByRole('menuitem', { name: 'New group' }).getAttribute('data-disabled')
    ).not.toBeNull()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)

    cleanup()
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    expect(screen.getByText('Reviewer')).toBeTruthy()
  })

  it('saves mixed bot and group order without opening a bot on drop', async () => {
    threeUnplacedBots()
    mocks.bots = mocks.bots.map((entry, index) =>
      index === 0 ? entry : { ...entry, sidebarOrder: index * 2 }
    )
    mocks.groups = [group({ sidebarOrder: 1 })]
    useAppStore.setState({
      folderWorkspaces: [home(), home({ id: 'fw-2' }), home({ id: 'fw-3' }), home({ id: 'fw-g' })]
    })
    renderSection()
    expect(rowIds()).toEqual(['bot-1', 'group-1', 'bot-2', 'bot-3'])
    // The folded header previews bots only.
    expect(screen.getByRole('button', { name: /^Collapse Bots, 3 bots/ })).toBeTruthy()
    stubRowRects()

    dragReviewerBelowJelly()

    // Reviewer lands between Scout and Jelly; each entry saves its new place through its own call.
    await vi.waitFor(() => expect(mocks.updateBot).toHaveBeenCalledTimes(3))
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'bots.groups.reorder', {
      groupId: 'group-1',
      sidebarOrder: 0
    })
    expect(new Map(mocks.updateBot.mock.calls.map(([bot, updates]) => [bot.id, updates]))).toEqual(
      new Map([
        ['bot-2', { sidebarOrder: 1 }],
        ['bot-1', { sidebarOrder: 2 }],
        ['bot-3', { sidebarOrder: 3 }]
      ])
    )
    fireEvent.click(screen.getByText('Reviewer'))
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('keeps a saved group listed after its last bot is gone', () => {
    mocks.bots = []
    mocks.groups = [group({ members: [] })]
    useAppStore.setState({ folderWorkspaces: [home({ id: 'fw-g' })] })
    renderSection()
    expect(screen.queryByText('Your AI teammate')).toBeNull()
    expect(screen.getByText('Crew')).toBeTruthy()
  })

  it('lists Start from scratch first in the New bot submenu and opens the blank dialog', async () => {
    renderSection()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New bot or group' }), { key: 'Enter' })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New bot' }), { key: 'ArrowRight' })
    })
    const submenu = screen.getAllByRole('menu').at(-1)!
    const scratch = screen.getByRole('menuitem', { name: 'Start from scratch' })
    expect(submenu.querySelector('[role="menuitem"]')).toBe(scratch)
    expect(document.activeElement).toBe(scratch)
    await act(async () => {
      fireEvent.click(scratch)
    })
    expect(document.querySelector('[data-new-bot-dialog]')).not.toBeNull()
  })

  it('offers New group once there are two bots', () => {
    threeUnplacedBots()
    renderSection()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New bot or group' }), { key: 'Enter' })
    expect(
      screen.getByRole('menuitem', { name: 'New group' }).getAttribute('data-disabled')
    ).toBeNull()
  })
})

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
