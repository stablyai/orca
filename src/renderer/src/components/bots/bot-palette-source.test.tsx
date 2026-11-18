// @vitest-environment happy-dom

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
import type { BotListWait } from '../../../../shared/bots/bot-list-waits'
import {
  makeFolderWorkspace,
  makeGroup,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from '../worktree-jump/worktree-jump-palette-test-fixtures'

const mocks = vi.hoisted(() => {
  const state: {
    bots: Bot[]
    waits: Record<string, BotListWait[]>
    openBotHomeTab: ReturnType<typeof vi.fn<(bot: Bot) => Promise<boolean>>>
  } = { bots: [], waits: {}, openBotHomeTab: vi.fn(async () => true) }
  return state
})

vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  useBots: () => mocks.bots,
  useBotsEnabled: () => true,
  useBotWaits: () => [],
  useListedBotItemsNeedingOwner: () => null,
  openBotHomeTab: (bot: Bot) => mocks.openBotHomeTab(bot)
}))
vi.mock('@/lib/bot-catalog-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readBotWaits: (bot: { id: string }) => mocks.waits[bot.id] ?? []
}))
vi.mock('@/lib/bot-group-list', () => ({ useBotGroups: () => [] }))
vi.mock('@/lib/bot-up-next-unseen', () => ({ useBotUpNextUnseen: () => 0 }))
vi.mock('./use-bot-purposes', () => ({ useBotPurposes: () => new Map<string, string>() }))
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
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange,
      placeholder
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
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

describe('Cmd+J bots', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    mocks.bots = []
    mocks.waits = {}
    mocks.openBotHomeTab.mockClear()
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

  it('puts a bot above a workspace that ties on the match', async () => {
    await renderPalette(
      botState([{ id: 'b1', name: 'Triage' }], {
        worktreesByRepo: { 'repo-1': [makeWorktree('wt-notes', 'Triage notes')] }
      })
    )
    await typeQuery('triage')
    const ids = rowIds()
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(botRowId('b1'))
    expect(ids[1].startsWith(WORKTREE_PREFIX)).toBe(true)
    // Enter targets the bot.
    expect(
      testContainer.querySelector<HTMLElement>('[data-command-dialog]')?.dataset.commandValue
    ).toBe(botRowId('b1'))
  })

  it('shows three bots after recent workspaces, waiting on you first', async () => {
    const wait: BotListWait = { label: 'approval' }
    mocks.waits = { b4: [wait] }
    await renderPalette(
      botState([
        { id: 'b1', name: 'One', lastActivityAt: 4000 },
        { id: 'b2', name: 'Two', lastActivityAt: 3000 },
        { id: 'b3', name: 'Three', lastActivityAt: 2000 },
        { id: 'b4', name: 'Four', lastActivityAt: 1000 }
      ])
    )
    expect(rowIds().filter((id) => id.startsWith(BOT_PREFIX))).toEqual([
      botRowId('b4'),
      botRowId('b1'),
      botRowId('b2')
    ])
    expect(testContainer.textContent).toContain('1 more')
  })

  it("opens the bot's Home chat on Enter", async () => {
    await renderPalette(botState([{ id: 'b1', name: 'Triage' }]))
    await typeQuery('triage')
    await act(async () => {
      testContainer.querySelector<HTMLElement>(`[data-command-item="${botRowId('b1')}"]`)?.click()
    })
    expect(mocks.openBotHomeTab).toHaveBeenCalledWith(mocks.bots[0])
  })

  it("lists a bot's chats in recents without listing its home as a workspace", async () => {
    const homeId = 'folder:fw-b1'
    await renderPalette(
      botState([{ id: 'b1', name: 'Triage' }], {
        showSleepingWorkspaces: true,
        ptyIdsByTabId: { 'term-bot': ['pty-term-bot'] },
        tabsByWorktree: { [homeId]: [makeTerminalTab('term-bot', homeId, 'Bot thread')] },
        unifiedTabsByWorktree: {
          [homeId]: [makeUnifiedTab('tab-bot', homeId, 'term-bot', 'Bot thread')]
        },
        groupsByWorktree: { [homeId]: [makeGroup(homeId, ['tab-bot'])] },
        activeGroupIdByWorktree: { [homeId]: `group-${homeId}` }
      })
    )
    expect(testContainer.textContent).toContain('Bot thread')
    expect(rowIds().some((id) => id.startsWith(WORKTREE_PREFIX))).toBe(false)
  })
})
