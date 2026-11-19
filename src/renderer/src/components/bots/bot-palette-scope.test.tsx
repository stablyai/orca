// @vitest-environment happy-dom

import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type * as BotCatalog from '@/lib/bot-catalog'
import WorktreeJumpPalette from '../worktree-jump/WorktreeJumpPalette'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import { BOTS_GROUP_KEY } from '../../../../shared/sidebar-list/sections/group-keys'
import { PALETTE_CLOSE_LINGER_MS } from '../worktree-jump/worktree-jump-palette-model'
import type { BotListWait } from '../../../../shared/bots/bot-list-waits'
import * as composerFocus from '@/components/native-chat/composer/focus/native-chat-composer-focus-intent'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import {
  makeFolderWorkspace,
  makeAgentEntry,
  makeRepo,
  makeUnifiedTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'

const purposeMocks = vi.hoisted(() => ({ purposes: new Map<string, string>() }))
const openMocks = vi.hoisted(() => {
  const groups: BotGroup[] = []
  return {
    groups,
    openGroup: vi.fn(async () => {}),
    taskRun: vi.fn(async () => []),
    taskRequests: vi.fn((): unknown[] => [])
  }
})
const mocks = vi.hoisted(() => {
  const state: {
    bots: Bot[]
    waits: Record<string, BotListWait[]>
    offlineHosts: Set<string>
    hostIds: string[]
    noWaits: BotListWait[]
    openBotHomeTab: ReturnType<typeof vi.fn<(bot: Bot) => Promise<boolean>>>
  } = {
    bots: [],
    waits: {},
    offlineHosts: new Set(),
    hostIds: ['local'],
    noWaits: [],
    openBotHomeTab: vi.fn(async () => true)
  }
  return state
})

vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  useBots: () => mocks.bots,
  useBotsEnabled: () => true,
  useBotWaits: (bot: Bot) => mocks.waits[bot.id] ?? mocks.noWaits,
  openBotHomeTab: (bot: Bot) => mocks.openBotHomeTab(bot)
}))
vi.mock('@/lib/bot-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBotWaits: (bot: { id: string }) => mocks.waits[bot.id] ?? mocks.noWaits,
  readBotHostIds: () => mocks.hostIds,
  readBotHostState: (hostId: string) => (mocks.offlineHosts.has(hostId) ? 'offline' : 'live'),
  readHostBots: (hostId: string) => mocks.bots.filter((bot) => bot.hostId === hostId)
}))
vi.mock('@/lib/bot-group-list', () => ({ useBotGroups: () => openMocks.groups }))
vi.mock('@/lib/bot-group-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBotGroups: () => openMocks.groups
}))
vi.mock('@/lib/bot-group-catalog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openBotGroup: () => openMocks.openGroup()
}))
vi.mock('@/components/cmd-j/task-search-requests', () => ({
  createCmdJTaskSearchRequests: () => openMocks.taskRequests()
}))
vi.mock('@/lib/bot-up-next-unseen', () => ({ useBotUpNextUnseen: () => 0 }))
vi.mock('./use-bot-purposes', () => ({ useBotPurposes: () => purposeMocks.purposes }))
vi.mock('./BotAvatar', () => ({
  BotAvatar: () => <span data-bot-avatar="true" />,
  BotAvatarTile: () => <span />
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/components/settings/navigation/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

vi.mock('@/components/sidebar/workspace-card/surface/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    // Pass controlled cmdk value through so Enter-target assertions reflect actual selection.
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      // Like the real dialog, its content (and the field) mounts a commit after it opens.
      const [mounted, setMounted] = React.useState(false)
      React.useEffect(() => setMounted(Boolean(open)), [open])
      return open && mounted ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange,
      placeholder,
      leading,
      ref
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
      leading?: React.ReactNode
      ref?: React.Ref<HTMLInputElement>
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <div>
          <span data-command-leading="true">{leading}</span>
          <input
            ref={ref}
            data-command-input="true"
            placeholder={placeholder}
            value={value}
            onChange={(event) => onValueChange?.(event.currentTarget.value)}
          />
        </div>
      )
    },
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    unifiedTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    showSleepingWorkspaces: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  })
  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

async function typeQuery(query: string): Promise<void> {
  await act(async () => {
    setCommandQuery?.(query)
  })
  await flushEffects()
}

function makeBot(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
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
}

function botState(
  bots: { id: string; name: string; lastActivityAt?: number }[],
  overrides: Partial<AppState> = {}
): Partial<AppState> {
  mocks.bots = bots.map((bot) => makeBot(bot.id, bot.name))
  return {
    folderWorkspaces: bots.map((bot) =>
      makeFolderWorkspace({
        id: `fw-${bot.id}`,
        name: `${bot.name} home`,
        lastActivityAt: bot.lastActivityAt ?? 0
      })
    ),
    ...overrides
  }
}

const BOT_PREFIX = encodePaletteIdentity(['extra', 'bots'])
const WORKTREE_PREFIX = encodePaletteIdentity(['worktree'])

function rowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')]
    .map((node) => node.dataset.commandItem ?? '')
    .filter((id) => id.startsWith(BOT_PREFIX) || id.startsWith(WORKTREE_PREFIX))
}

function botRowId(botId: string): string {
  return encodePaletteIdentity(['extra', 'bots', `bot:local/${botId}`])
}

function input(): HTMLInputElement {
  return testContainer.querySelector<HTMLInputElement>('[data-command-input]')!
}

/** A typed character, as the browser announces it before inserting. */
async function typeScopeKey(data = '@'): Promise<void> {
  await act(async () => {
    input().dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data,
        bubbles: true,
        cancelable: true
      })
    )
  })
  await flushEffects()
}

async function pressBackspace(repeat: boolean): Promise<void> {
  await act(async () => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', repeat, bubbles: true, cancelable: true })
    )
  })
  await flushEffects()
}

async function choose(itemId: string): Promise<void> {
  await act(async () => {
    testContainer.querySelector<HTMLElement>(`[data-command-item="${itemId}"]`)?.click()
  })
  await flushEffects()
}

function hasItem(itemId: string): boolean {
  return testContainer.querySelector(`[data-command-item="${itemId}"]`) !== null
}

function scopeChipShown(): boolean {
  return testContainer.querySelector('[data-command-leading] button') !== null
}

const SHOW_EVERYTHING = '__bot_scope_show_everything__'
const SEARCH_BOTS = '__bot_scope_search_bots__'

describe('Cmd+K @ shows only bots', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    mocks.bots = []
    mocks.waits = {}
    mocks.offlineHosts = new Set()
    mocks.hostIds = ['local']
    purposeMocks.purposes = new Map()
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  const triageState = (): Partial<AppState> =>
    botState([{ id: 'b1', name: 'Triage' }], {
      worktreesByRepo: { 'repo-1': [makeWorktree('wt-notes', 'Triage notes')] }
    })

  it('lists only bots after @ is typed into the empty field', async () => {
    await renderPalette(triageState())
    await typeScopeKey()
    await typeQuery('triage')
    expect(scopeChipShown()).toBe(true)
    expect(rowIds()).toEqual([botRowId('b1')])
  })

  it('treats full-width ＠ like @', async () => {
    await renderPalette(triageState())
    await typeScopeKey('\uff20')
    await typeQuery('triage')
    expect(rowIds()).toEqual([botRowId('b1')])
  })

  it('keeps a pasted @ as text', async () => {
    await renderPalette(triageState())
    await typeQuery('@triage')
    expect(scopeChipShown()).toBe(false)
    expect(input().value).toBe('@triage')
  })

  it('stays scoped on a held Backspace and leaves on a fresh one', async () => {
    await renderPalette(triageState())
    await typeScopeKey()
    await pressBackspace(true)
    expect(scopeChipShown()).toBe(true)
    await pressBackspace(false)
    expect(scopeChipShown()).toBe(false)
  })

  it('hands back the text with its @ from "search everything"', async () => {
    await renderPalette(triageState())
    await typeScopeKey()
    await typeQuery('zzz')
    expect(rowIds()).toEqual([])
    await choose(SHOW_EVERYTHING)
    expect(scopeChipShown()).toBe(false)
    expect(input().value).toBe('@zzz')
  })

  it('hands back a pasted link without the @, so it opens as a link', async () => {
    const link = 'https://github.com/acme/project/issues/7'
    await renderPalette(triageState())
    await typeScopeKey()
    await typeQuery(link)
    await choose(SHOW_EVERYTHING)
    expect(input().value).toBe(link)
  })

  it('offers bots a filter hides, keeps the filter while scoped, and applies it again after', async () => {
    await renderPalette({ ...triageState(), filterRepoIds: ['repo-1'] })
    await typeQuery('triage')
    expect(rowIds().some((id) => id.startsWith(BOT_PREFIX))).toBe(false)
    await choose(SEARCH_BOTS)
    expect(rowIds()).toEqual([botRowId('b1')])
    expect(input().value).toBe('triage')
    await pressBackspace(false) // field not empty: stays
    await typeQuery('')
    await pressBackspace(false)
    await typeQuery('triage')
    expect(rowIds().some((id) => id.startsWith(BOT_PREFIX))).toBe(false)
    expect(hasItem(SEARCH_BOTS)).toBe(true)
  })

  it('shows which part of the purpose matched alongside a name match', async () => {
    purposeMocks.purposes = new Map([
      ['local\u0000b1', 'Handles every inbound support message and triages Discord threads']
    ])
    await renderPalette(botState([{ id: 'b1', name: 'Support' }]))
    await typeQuery('support discord')
    const row = testContainer.querySelector(`[data-command-item="${botRowId('b1')}"]`)
    expect(row?.textContent).toContain('triages Discord threads')
    expect(row?.textContent).not.toContain('Handles every inbound')
  })

  it('keeps a waiting line and its accessible purpose-match evidence', async () => {
    mocks.waits = { b1: [{ label: 'approval' }] }
    purposeMocks.purposes = new Map([['local\u0000b1', 'Answers WeChat support threads']])
    await renderPalette(botState([{ id: 'b1', name: 'Support' }]))
    await typeScopeKey()
    await typeQuery('wechat')
    const row = testContainer.querySelector(`[data-command-item="${botRowId('b1')}"]`)
    expect(row?.textContent).toContain('Waiting for approval')
    expect(row?.textContent).toContain('Matches purpose.')
    expect(row?.textContent).not.toContain('Answers WeChat support threads')
  })

  it("keeps its own chat's approval question ahead of purpose evidence", async () => {
    const state = botState([{ id: 'b1', name: 'Support' }])
    mocks.bots[0] = { ...mocks.bots[0], chatSessionId: 'approval-chat' }
    const entry = makeAgentEntry('approval-chat', 'waiting', Date.now(), {
      paneKey: structuredAgentSessionStatusPaneKey('approval-chat'),
      worktreeId: 'folder:fw-b1',
      agentType: 'claude',
      lastAssistantMessage: 'Approve the release?'
    })
    state.agentStatusByPaneKey = acceptedAgentStatuses([[entry.paneKey, entry]])
    purposeMocks.purposes = new Map([['local\u0000b1', 'Answers WeChat support threads']])
    await renderPalette(state)
    await typeScopeKey()
    await typeQuery('wechat')
    const row = testContainer.querySelector(`[data-command-item="${botRowId('b1')}"]`)
    expect(row?.textContent).toContain('Approve the release?')
    expect(row?.textContent).toContain('Matches purpose.')
    expect(row?.textContent).not.toContain('Answers WeChat support threads')
  })

  it('keeps a disconnected line and purpose-match evidence for a paused offline bot', async () => {
    const state = botState([{ id: 'b1', name: 'Reviewer' }])
    mocks.bots[0] = stampBotHost('runtime:offline', { ...mocks.bots[0], paused: true })
    state.folderWorkspaces = state.folderWorkspaces?.map((home) => ({
      ...home,
      executionHostId: 'runtime:offline'
    }))
    mocks.offlineHosts.add('runtime:offline')
    mocks.hostIds = ['local', 'runtime:offline']
    purposeMocks.purposes = new Map([['runtime:offline\u0000b1', 'Reviews WeChat support threads']])
    await renderPalette(state)
    await typeScopeKey()
    await typeQuery('wechat')
    const id = encodePaletteIdentity(['extra', 'bots', 'bot:runtime:offline/b1'])
    const row = testContainer.querySelector(`[data-command-item="${id}"]`)
    expect(row?.textContent).toContain('Disconnected')
    expect(row?.textContent).toContain('Matches purpose.')
    expect(row?.textContent).not.toContain('Reviews WeChat support threads')
  })
})

function mountOpenedPane(attribute: string, tabId: string): HTMLTextAreaElement {
  const pane = document.createElement('div')
  pane.setAttribute(attribute, tabId)
  const composer = document.createElement('textarea')
  pane.append(composer)
  document.body.append(pane)
  return composer
}

/** Opening the chat closes the palette while preserving a folded Bots section. */
async function expectPaletteClosedWithBotsFolded(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(testContainer.querySelector('[data-command-dialog]')).toBeNull()
      expect(useAppStore.getState().collapsedGroups.has(BOTS_GROUP_KEY)).toBe(true)
    },
    { timeout: PALETTE_CLOSE_LINGER_MS * 4 }
  )
}

describe('Cmd+K opening a bot or group from the palette', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    mocks.bots = []
    mocks.waits = {}
    mocks.offlineHosts = new Set()
    mocks.hostIds = ['local']
    openMocks.groups = []
    openMocks.openGroup.mockClear()
    openMocks.taskRequests.mockReset()
    openMocks.taskRequests.mockImplementation(() => [])
    openMocks.taskRun.mockClear()
    purposeMocks.purposes = new Map()
    vi.stubGlobal('api', { ...window.api, ui: { set: vi.fn(() => Promise.resolve()) } })
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.unstubAllGlobals()
  })

  const foldedSidebar: Partial<AppState> = {
    sidebarOpen: true,
    sidebarBody: 'workspaces',
    collapsedGroups: new Set([BOTS_GROUP_KEY])
  }

  it("keeps Bots folded after a bot's chat opens and the palette has gone", async () => {
    await renderPalette(
      botState([{ id: 'b1', name: 'Triage' }], {
        ...foldedSidebar,
        activeTabIdByWorktree: { 'folder:fw-b1': 'term-b1' }
      })
    )
    await typeQuery('triage')
    await choose(botRowId('b1'))
    mountOpenedPane('data-terminal-tab-id', 'term-b1').focus()
    await expectPaletteClosedWithBotsFolded()
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
  })

  it("keeps Bots folded after a group's room opens", async () => {
    openMocks.groups = [
      {
        id: 'group-1',
        name: 'Crew',
        hostId: 'local',
        revision: 1,
        folder: 'group-crew',
        folderWorkspaceId: 'fw-g',
        createdAt: 1,
        members: [],
        replyMode: { kind: 'mentions' }
      }
    ]
    const roomTab = {
      ...makeUnifiedTab('room-tab', 'folder:fw-g', 'group-1', 'Crew'),
      contentType: 'room' as const
    }
    await renderPalette({
      ...foldedSidebar,
      folderWorkspaces: [makeFolderWorkspace({ id: 'fw-g', name: 'Crew home' })],
      unifiedTabsByWorktree: { 'folder:fw-g': [roomTab] }
    })
    const composer = mountOpenedPane('data-room-overlay-tab-id', 'room-tab')
    const request = vi.spyOn(composerFocus, 'requestNativeChatComposerFocus')
    const unregister = composerFocus.registerNativeChatComposerReclaim(
      'room-tab',
      () => composer.focus(),
      composer.parentElement
    )
    try {
      await typeQuery('crew')
      await choose(encodePaletteIdentity(['extra', 'bots', 'group:local/group-1']))
      expect(request).toHaveBeenCalledWith('room-tab')
      await expectPaletteClosedWithBotsFolded()
      expect(document.activeElement).toBe(composer)
    } finally {
      unregister()
      request.mockRestore()
    }
  })

  it('drops a pending task search when showing only bots', async () => {
    openMocks.taskRequests.mockImplementation(() => [
      {
        id: 'github',
        provider: 'github',
        hostId: 'local',
        hostLabel: 'local',
        run: openMocks.taskRun
      }
    ])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await renderPalette({
        ...botState([{ id: 'b1', name: 'Triage' }]),
        filterRepoIds: ['repo-1']
      })
      await typeQuery('triage')
      // Within the search's debounce, switch to bots for the same text.
      await choose(SEARCH_BOTS)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
      expect(rowIds()).toEqual([botRowId('b1')])
      expect(openMocks.taskRun).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
