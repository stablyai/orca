// @vitest-environment happy-dom
// A shared agent's chats open in the list they are in: another person's in the view of their tabs,
// never copied into this window's own strip or marked seen for them.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { botChatOffersDelete, type BotChatTreeChat } from '../../../../../shared/bots/bot-chat-tree'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { viewedChatTabId } from '@/components/native-chat/pane/ownership/native-chat-tab-owner'
import { openBotChatById, openBotChatRow } from '../bot-chat-row-open'
import { useBotChatOwner } from '../use-bot-chat-identity'
import { useChatsPersonPick } from '../chats-person-pick'
import { ViewedTabListOverlay } from './ViewedTabListOverlay'
import { ViewedTabListSurface } from './ViewedTabListSurface'
import {
  useViewedTabList,
  viewTabList,
  type PersonTabListView,
  type ViewedTabList
} from './viewed-tab-list'
import type { PersonTabListRead } from './use-person-tab-list'
import type * as BotHosts from '@/lib/bot-hosts'
import type * as BotCatalog from '@/lib/bot-catalog'
import type * as FolderRecords from '../../../store/folder-workspaces/folder-workspace-record-index'
import { useAppStore } from '@/store'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { BOTS_TAB_LIST_VIEWS_CAPABILITY } from '../../../../../shared/bot-runtime-capabilities'
import { useTabListPeople } from './tab-list-people'

// The host and the window's own tabs: what a click must leave alone for another person's chat.
const host = vi.hoisted(() => {
  const bots: Bot[] = []
  return {
    rpc: vi.fn(async (_bot: unknown, _method: string, _params?: unknown): Promise<unknown> => null),
    activate: vi.fn(async () => true),
    openHomeTab: vi.fn(async () => true),
    bots,
    home: { id: 'home-1', externalConversations: [] }
  }
})
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: host.rpc,
  isListedBotHost: () => true
}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: host.activate
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  openBotHome: () => true,
  openBotHomeTab: host.openHomeTab,
  useBots: () => host.bots,
  useBotsEnabled: () => true
}))
vi.mock(
  '../../../store/folder-workspaces/folder-workspace-record-index',
  async (importOriginal) => ({
    ...(await importOriginal<typeof FolderRecords>()),
    selectFolderWorkspaceOnHost: () => host.home
  })
)
// Mate's list as the host streams it: one terminal, active on their side.
let theirList: PersonTabListRead = { state: 'loading' }
const readsTheirList = vi.hoisted(() => vi.fn())
vi.mock('./use-person-tab-list', () => ({
  usePersonTabList: (...args: unknown[]) => {
    readsTheirList(...args)
    return theirList
  }
}))
// The chat and terminal views themselves, by what they were asked to show.
vi.mock('@/components/native-chat/NativeChatView', () => ({
  default: (props: { sessionId: string; readOnly?: true }) => (
    <div data-chat={props.sessionId} data-read-only={String(props.readOnly === true)} />
  )
}))
vi.mock('@/components/dashboard/terminal-preview/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => <div data-terminal={ptyId} />
}))

const MATE = { accountId: 'acc-mate', name: 'Mate Park' }
const HOME = folderWorkspaceKey('home-1')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only these fields.
const ownersCopy = {
  id: 'bot-1',
  name: 'Helper',
  hostId: 'local',
  folderWorkspaceId: 'home-1',
  agent: 'claude',
  avatar: null,
  chatSessionId: 'owner-home'
} as unknown as Bot
const matesCopy: Bot = {
  ...ownersCopy,
  chatSessionId: 'mate-home',
  shareViewer: { accountId: MATE.accountId, ownerName: 'Owner', teammates: [MATE] }
}

function chat(extra: Partial<BotChatTreeChat>): BotChatTreeChat {
  return {
    chatId: 'c1',
    title: 'Chat',
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
    ...extra
  }
}

function viewed(): ViewedTabList | null {
  return renderHook(() => useViewedTabList(HOME)).result.current
}

beforeEach(() => {
  host.bots = [ownersCopy]
})
afterEach(() => {
  cleanup()
  viewTabList(HOME, null)
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  vi.clearAllMocks()
})

it('opens a teammate’s chat in the view of their tabs, never in this window’s own', () => {
  openBotChatRow(ownersCopy, chat({ chatId: 'mate-side', person: MATE }))
  expect(viewed()).toEqual({
    person: { accountId: MATE.accountId },
    picked: { sessionId: 'mate-side' }
  })
  expect(host.activate).not.toHaveBeenCalled()
  expect(host.openHomeTab).not.toHaveBeenCalled()
  expect(host.rpc).not.toHaveBeenCalled()
})

it('opens the owner’s Home from a teammate’s Chats in the owner’s tabs', () => {
  openBotChatRow(matesCopy, chat({ chatId: 'owner-home', homeOf: 'Owner', title: 'Owner’s Home' }))
  expect(viewed()).toEqual({ person: 'owner', picked: { sessionId: 'owner-home' } })
  expect(host.activate).not.toHaveBeenCalled()
  expect(host.rpc).not.toHaveBeenCalled()
})

it('opens this viewer’s own chat in their own tabs, leaving the view', async () => {
  viewTabList(HOME, { accountId: MATE.accountId })
  openBotChatRow(ownersCopy, chat({ chatId: 'own-side' }))
  expect(viewed()).toBeNull()
  expect(host.activate).toHaveBeenCalledWith({
    structuredSession: { sessionId: 'own-side', workspaceId: HOME }
  })
  await vi.waitFor(() =>
    expect(host.rpc).toHaveBeenCalledWith(ownersCopy, 'bots.chats.seen', {
      sessionIds: ['own-side']
    })
  )
})

const terminal: RuntimeMobileSessionClientTab = {
  id: 'mate-term',
  type: 'terminal',
  title: 'Terminal 1',
  parentTabId: 'mate-term',
  leafId: 'leaf-1',
  ptyId: 'pty-mate',
  isActive: true,
  status: 'ready',
  terminal: 'term-mate'
}

function surface(view: PersonTabListView): void {
  render(
    <ViewedTabListSurface
      bot={ownersCopy}
      homeKey={HOME}
      view={view}
      people={{
        own: { person: 'owner', name: 'Owner' },
        others: [{ person: { accountId: MATE.accountId }, name: MATE.name }]
      }}
      holderName={MATE.name}
    />
  )
}

it('shows a picked chat that isn’t in their tabs to read, standing no other tab in for it', () => {
  theirList = { state: 'ready', list: { tabs: [terminal], theirActiveTabId: 'mate-term' } }
  surface({ person: { accountId: MATE.accountId }, picked: { sessionId: 'mate-side' } })
  expect(document.querySelector('[data-chat="mate-side"]')?.getAttribute('data-read-only')).toBe(
    'true'
  )
  expect(screen.getByText('Not open in Mate Park’s tabs. Read only.')).toBeTruthy()
  expect(document.querySelector('[data-terminal]')).toBeNull()
  expect(screen.getByRole('tab').getAttribute('aria-selected')).toBe('false')
})

it('names the agent on a chat viewed from another person’s tabs, which this copy doesn’t link', () => {
  const owner = (tabId: string) =>
    renderHook(() => useBotChatOwner({ tabId, sessionId: 'mate-home', target: { kind: 'local' } }))
      .result.current.turnBot?.name ?? null
  expect(owner(viewedChatTabId(HOME, 'mate-home-tab'))).toBe('Helper')
  // The same session in a tab of this window's own is not the agent's: nothing links it here.
  expect(owner('own-tab')).toBeNull()
})

it('lists everyone’s chats again when the view of a teammate picked there is left', () => {
  const entries = [
    { pick: { kind: 'owner' as const } },
    { pick: { kind: 'person' as const, person: MATE } }
  ]
  const { result } = renderHook(() => useChatsPersonPick(ownersCopy, entries))
  act(() => result.current.setPick({ kind: 'owner' }))
  expect(result.current.pick).toEqual({ kind: 'owner' })
  act(() => result.current.setPick({ kind: 'person', person: MATE }))
  expect(result.current.pick).toEqual({ kind: 'person', person: MATE })
  // × on the viewed strip.
  act(() => viewTabList(HOME, null))
  expect(result.current.pick).toEqual({ kind: 'everyone' })
})

it('goes back to this window’s own tabs when the agent is no longer shared with this account', () => {
  viewTabList(HOME, 'owner')
  host.bots = []
  render(<ViewedTabListOverlay worktreeId={HOME} />)
  expect(viewed()).toBeNull()
})

it('opens a chat named only by its session (an item’s link, Needs you) in the list the host says it is in', async () => {
  // The host's read of that one chat, stamped with whose it is.
  host.rpc.mockImplementation(async (_bot, method, params) =>
    method !== 'bots.chatTree'
      ? null
      : {
          chats:
            typeof params === 'object' &&
            params !== null &&
            'chatId' in params &&
            params.chatId === 'mate-side'
              ? [chat({ chatId: 'mate-side', person: MATE })]
              : [],
          workspaceChats: {}
        }
  )
  await openBotChatById(ownersCopy, 'mate-side')
  expect(viewed()).toEqual({
    person: { accountId: MATE.accountId },
    picked: { sessionId: 'mate-side' }
  })
  expect(host.activate).not.toHaveBeenCalled()
  expect(host.rpc).not.toHaveBeenCalledWith(ownersCopy, 'bots.chats.seen', expect.anything())
  // One the host lists as no one's yet (just made here) is this viewer's own.
  await openBotChatById(ownersCopy, 'just-made')
  expect(viewed()).toBeNull()
  expect(host.activate).toHaveBeenCalledWith({
    structuredSession: { sessionId: 'just-made', workspaceId: HOME }
  })
})

it('never offers to delete another person’s live Home', () => {
  const matesHome = chat({ chatId: 'mate-home', homeOf: 'Mate Park', person: MATE })
  expect(botChatOffersDelete(matesHome)).toBe(false)
  expect(botChatOffersDelete({ ...matesHome, closed: true })).toBe(true)
  expect(botChatOffersDelete(chat({ chatId: 'mate-side', person: MATE }))).toBe(true)
})

it('shows their active tab next when the chat picked from Chats is closed in their list', () => {
  const matesChat: RuntimeMobileSessionClientTab = {
    id: 'mate-chat-tab',
    type: 'agent-session',
    title: 'Side chat',
    sessionId: 'mate-side',
    agent: 'claude',
    isActive: false
  }
  theirList = {
    state: 'ready',
    list: { tabs: [terminal, matesChat], theirActiveTabId: 'mate-term' }
  }
  viewTabList(HOME, { accountId: MATE.accountId }, { sessionId: 'mate-side' })
  const view = viewed()
  if (view?.person == null) {
    throw new Error('Mate’s tabs are not shown')
  }
  surface(view)
  fireEvent.click(screen.getByRole('button', { name: 'Close Side chat' }))
  expect(viewed()).toEqual({ person: { accountId: MATE.accountId }, picked: null })
  expect(host.rpc).toHaveBeenCalledWith(ownersCopy, 'session.tabs.close', {
    worktree: `id:${HOME}`,
    tabId: 'mate-chat-tab',
    reason: 'user',
    person: { accountId: MATE.accountId }
  })
})

/** Mate's copy, on a paired host whose Orca has (or, older, lacks) the view of others' lists. */
function matesCopyOn(capabilities: string[]): Bot {
  const environmentId = `env-${capabilities.length}`
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [
        environmentId,
        runtimeEnvironmentStatusFromSnapshot({
          environmentId,
          pairingRevision: 0,
          sequence: 1,
          checkedAt: 1,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capability check reads only these.
          status: { runtimeId: environmentId, capabilities } as RuntimeStatus,
          verification: 'verified',
          transport: 'ready'
        })
      ]
    ])
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a paired host's copy, as the host catalog lists it (Bot types only this app's own).
  return { ...matesCopy, hostId: `runtime:${environmentId}` } as unknown as Bot
}

it('shows no one else’s tabs on a host too old to name whose list it answers with', () => {
  const newer = matesCopyOn([BOTS_TAB_LIST_VIEWS_CAPABILITY])
  expect(renderHook(() => useTabListPeople(newer)).result.current?.others).toHaveLength(1)
  const older = matesCopyOn([])
  host.bots = [older]
  // The avatar menu and the row's entry list no one.
  expect(renderHook(() => useTabListPeople(older)).result.current).toBeNull()
  // The owner's chat reads alone; their list is never asked for.
  openBotChatRow(older, chat({ chatId: 'owner-side' }))
  render(<ViewedTabListOverlay worktreeId={HOME} />)
  expect(document.querySelector('[data-chat="owner-side"]')?.getAttribute('data-read-only')).toBe(
    'true'
  )
  expect(screen.queryByRole('tab')).toBeNull()
  expect(readsTheirList).not.toHaveBeenCalled()
  expect(host.activate).not.toHaveBeenCalled()
  // Chats lists the owner's chats by its own filter, showing no list.
  act(() => viewTabList(HOME, null))
  const { result } = renderHook(() =>
    useChatsPersonPick(older, [
      { pick: { kind: 'owner' } },
      { pick: { kind: 'person', person: MATE } }
    ])
  )
  act(() => result.current.setPick({ kind: 'owner' }))
  expect(result.current.pick).toEqual({ kind: 'owner' })
  expect(viewed()).toBeNull()
})
