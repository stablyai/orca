// @vitest-environment happy-dom

import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type * as BotCatalog from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import type { Bot } from '../../../../shared/bot-types'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'

const mocks = vi.hoisted(() => {
  const bots: Bot[] = []
  const groups: BotGroup[] = []
  return {
    bots,
    groups,
    rpc: vi.fn(async (_target: unknown, _method: string, _params?: unknown) => ({})),
    activate: vi.fn(),
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

function rowEntry(botId: string): HTMLElement {
  const entry = document.querySelector<HTMLElement>(
    `[data-project-group-header-id="local/${botId}"]`
  )
  if (!entry) {
    throw new Error(`no entry for ${botId}`)
  }
  return entry
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
  mocks.onOpenBot.mockReset()
  mocks.updateBot.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('SidebarBotsSection', () => {
  it('shows the empty state before the first bot', () => {
    renderSection()
    expect(screen.getByText('Bots')).toBeTruthy()
    expect(screen.getByText('Meet your AI teammate')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create a bot' })).toBeTruthy()
  })

  it('lists a bot by avatar and name and opens its home on click', () => {
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    expect(screen.getByText('R')).toBeTruthy()
    fireEvent.click(screen.getByText('Reviewer'))
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-1' }))
    expect(mocks.onOpenBot).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'marks an unread bot with the same blue dot in either card style (new: %s) and skips a bot whose home is not loaded',
    (newCardStyle) => {
      mocks.bots = [bot(), bot({ id: 'bot-2', name: 'Scout', folderWorkspaceId: 'fw-missing' })]
      useAppStore.setState({
        folderWorkspaces: [home({ isUnread: true })],
        settings: {
          ...getDefaultSettings('/home/me'),
          experimentalNewWorktreeCardStyle: newCardStyle
        }
      })
      renderSection()
      expect(screen.queryByText('Scout')).toBeNull()
      expect(document.querySelectorAll('[data-bot-unread-dot]')).toHaveLength(1)
    }
  )

  it('collapses its rows from the header', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: /^Collapse Bots,/ }))
    expect(screen.queryByText('Reviewer')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand Bots,/ }))
    expect(screen.getByText('Reviewer')).toBeTruthy()
  })

  it('lets go of focus after a pointer click on the header, but keeps it from the keyboard', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    mocks.bots = [bot()]
    useAppStore.setState({ folderWorkspaces: [home()] })
    renderSection()
    const header = screen.getByRole('button', { name: /^Collapse Bots,/ })
    // Held focus would keep the folded faces spread after the pointer leaves.
    header.focus()
    fireEvent.click(header, { detail: 1 })
    expect(document.activeElement).not.toBe(header)
    header.focus()
    fireEvent.click(header, { detail: 0 })
    expect(document.activeElement).toBe(header)
  })

  it('opens a bot from its face and unfolds the section; the rest of the header only folds', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    // Room for all three faces.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(
          private readonly callback: (entries: { contentRect: { width: number } }[]) => void
        ) {}
        observe(): void {
          this.callback([{ contentRect: { width: 68 } }])
        }
        disconnect(): void {}
      }
    )
    threeUnplacedBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'Scout · Idle' }))
    // Opened as its row would be, with the section unfolded so that row shows.
    expect(mocks.activate).toHaveBeenCalledWith(expect.objectContaining({ id: 'bot-2' }))
    expect(mocks.onOpenBot).toHaveBeenCalledOnce()
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)
    expect(screen.getByText('Scout')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Collapse Bots,/ }))
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Expand Bots,/ }))
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)
    expect(mocks.activate).toHaveBeenCalledOnce()
  })

  it('folds open from the "+N" circle', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    threeUnplacedBots()
    useAppStore.setState({ collapsedGroups: new Set(['bots']) })
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more bots' }))
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('saves the order a drag gives, on the host, for every bot it places', async () => {
    threeUnplacedBots()
    renderSection()
    stubRowRects()

    dragReviewerBelowJelly()

    await vi.waitFor(() => expect(mocks.updateBot).toHaveBeenCalledTimes(3))
    expect(new Map(mocks.updateBot.mock.calls.map(([bot, updates]) => [bot.id, updates]))).toEqual(
      new Map([
        ['bot-2', { sidebarOrder: 0 }],
        ['bot-3', { sidebarOrder: 1 }],
        ['bot-1', { sidebarOrder: 2 }]
      ])
    )
    // The release's click is the drag's, not an open.
    fireEvent.click(screen.getByText('Reviewer'))
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('drags a floating copy of the bot and slides the others aside, as a workspace row does', () => {
    threeUnplacedBots()
    renderSection()
    stubRowRects()
    const entry = rowEntry('bot-1')

    fireEvent.pointerDown(screen.getByText('Reviewer'), {
      pointerId: 1,
      button: 0,
      clientX: 20,
      clientY: 10
    })
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 20, clientY: 115, buttons: 1 })
      )
    })
    const preview = document.querySelector('[data-worktree-sidebar-drag-preview]')
    expect(preview?.textContent).toContain('Reviewer')
    expect(entry.className).toContain('opacity-0')
    // Scout and Jelly slide up into the gap Reviewer left.
    const slide = (botId: string): string => {
      const content = rowEntry(botId).firstElementChild
      return content instanceof HTMLElement ? content.style.transform : ''
    }
    expect([slide('bot-1'), slide('bot-2'), slide('bot-3')]).toEqual([
      '',
      'translateY(-40px)',
      'translateY(-40px)'
    ])

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 20, clientY: 115 })
      )
    })
    expect(document.querySelector('[data-worktree-sidebar-drag-preview]')).toBeNull()
    expect(entry.className).not.toContain('opacity-0')
    expect(slide('bot-2')).toBe('')
  })

  it('keeps New bot access while empty and folds the onboarding card away', () => {
    vi.stubGlobal('api', { ui: { set: vi.fn(() => Promise.resolve()) } })
    renderSection()
    // No count beside the title while there is nothing to count.
    expect(screen.queryByText('0')).toBeNull()
    const emptyHeader = screen.getByRole('button', { name: /^Collapse Bots, 0 bots/ })
    expect(emptyHeader.hasAttribute('disabled')).toBe(false)
    fireEvent.click(emptyHeader)
    expect(useAppStore.getState().collapsedGroups.has('bots')).toBe(true)
    expect(screen.queryByText('Meet your AI teammate')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand Bots, 0 bots/ }))
    expect(screen.getByText('Meet your AI teammate')).toBeTruthy()
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

  it("lists groups among the bots in one order, and a drop saves a group's place on its host", async () => {
    threeUnplacedBots()
    mocks.bots = mocks.bots.map((entry, index) => ({ ...entry, sidebarOrder: index * 2 }))
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
  })

  it('keeps a saved group listed after its last bot is gone', () => {
    mocks.bots = []
    mocks.groups = [group({ members: [] })]
    useAppStore.setState({ folderWorkspaces: [home({ id: 'fw-g' })] })
    renderSection()
    expect(screen.queryByText('Meet your AI teammate')).toBeNull()
    expect(screen.getByText('Crew')).toBeTruthy()
  })

  it("keeps a group's dot off while only its members' homes and workers work", () => {
    groupWithBusyMembers()
    renderSection()
    expect(groupStatusSlot().querySelector('[data-agent-spinner]')).toBeNull()
  })

  it("shows a group working while a member's turn for its room runs", () => {
    groupWithBusyMembers()
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: state.agentStatusByPaneKey.replace(
        Object.entries(sessionStatus('bot-group-member-1', folderWorkspaceKey('fw-1')))
      )
    }))
    renderSection()
    expect(groupStatusSlot().querySelector('[data-agent-spinner]')).not.toBeNull()
  })

  it('lists Start from scratch first in the New bot submenu and opens the blank dialog', async () => {
    renderSection()
    fireEvent.keyDown(screen.getByRole('button', { name: 'New bot or group' }), { key: 'Enter' })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('menuitem', { name: 'New bot' }), { key: 'ArrowRight' })
    })
    const submenu = screen.getAllByRole('menu').at(-1)!
    const items = [...submenu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(items).toEqual([
      'Start from scratch',
      'Browse templates',
      'From a link…',
      'Import from another app…'
    ])
    const scratch = screen.getByRole('menuitem', { name: 'Start from scratch' })
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

/** A working structured session its host holds, which stays fresh without a clock. */
function sessionStatus(sessionId: string, worktreeId: string): Record<string, AgentStatusEntry> {
  const tabId = structuredAgentSessionTabId(sessionId)
  const paneKey = structuredAgentSessionPaneKey(tabId, sessionId)
  return {
    [paneKey]: {
      state: 'working',
      prompt: 'triage',
      updatedAt: 1,
      stateStartedAt: 1,
      structuredHostOwned: true,
      agentType: 'claude',
      paneKey,
      tabId,
      worktreeId,
      stateHistory: []
    }
  }
}

/** Crew, whose first bot's worker workspace and second bot's Home chat are working; nobody has posted. */
function groupWithBusyMembers(): void {
  mocks.bots = [bot(), bot({ id: 'bot-2', name: 'Scout', folderWorkspaceId: 'fw-2' })]
  mocks.groups = [group()]
  const worker = makeWorktree({ id: 'repo-1::/fix', repoId: 'repo-1', path: '/fix' })
  const lineage: WorkspaceLineage = {
    childWorkspaceKey: worktreeWorkspaceKey(worker.id),
    parentWorkspaceKey: folderWorkspaceKey('fw-1'),
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
  useAppStore.setState({
    folderWorkspaces: [home(), home({ id: 'fw-2' }), home({ id: 'fw-g' })],
    worktreesByRepo: { 'repo-1': [worker] },
    workspaceLineageByChildKey: { [lineage.childWorkspaceKey]: lineage },
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        ...sessionStatus('worker-session', worker.id),
        ...sessionStatus('home-session', folderWorkspaceKey('fw-2'))
      })
    )
  })
}

function groupStatusSlot(): Element {
  const slot = rowEntry('group-1').querySelector('[data-worktree-card-status-slot]')
  if (!slot) {
    throw new Error('no status slot on the group row')
  }
  return slot
}
