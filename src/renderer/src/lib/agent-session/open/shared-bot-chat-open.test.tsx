// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { BotHomeChat } from '@/components/bots/BotHomeChat'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  SharedBotHostsState,
  SharedBotHostView
} from '../../../../../shared/bots/shared-bot-hosts'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { publishBots, readHostBots, setBotHostListing } from '../../bot-catalog-snapshot'
import { newBotHomeChat, openBotHome, openBotHomeTab, startBotSession } from '../../bot-catalog'
import { installSharedBotNewChatSwap } from '@/runtime/hosts/shared-bot-hosts/shared-bot-new-chat-swap'
import { buildWorkspaceSessionPayload } from '../../workspace/persistence/workspace-session'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { applyLocalStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'live',
  holds: true,
  held: []
}
const HOST = toRuntimeExecutionHostId(SHARED.environmentId)
const HOME_KEY = folderWorkspaceKey('home-1')
const tabs = () =>
  (useAppStore.getState().unifiedTabsByWorktree[HOME_KEY] ?? []).filter(
    (tab) => tab.contentType === 'agent-session'
  )

// The agent as its owner's host lists it: its home is a workspace this account can't see.
const ivy: Bot = {
  id: 'bot-1',
  name: 'Ivy',
  hostId: 'local',
  folder: 'ivy',
  folderWorkspaceId: 'owners-home',
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

const home: FolderWorkspace = {
  id: 'home-1',
  projectGroupId: 'bots-group',
  name: 'Ivy',
  folderPath: '/user-data/shared-agents/share-1',
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

function resetStore(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a catalog with only this computer's shared-agent home.
    { repos: [], worktreesByRepo: {}, folderWorkspaces: [home] } as unknown as Partial<AppState>
  )
}

// This account's Home on the owner's computer: made on first open, replaced by New Home Chat.
let theirHome: string | null = null
// While set, the owner's computer hasn't answered an open yet.
let openAnswered: Promise<void> | null = null
let homesMade = 0
const homeAnswer = (method: string): { sessionId: string } | null => {
  if (method === 'bots.chat.open') {
    theirHome ??= `their-home-${++homesMade}`
    return { sessionId: theirHome }
  }
  if (method === 'bots.chat.reset') {
    theirHome = `their-home-${++homesMade}`
    return { sessionId: theirHome }
  }
  return null
}

let stopCatalog: () => void = () => {}
let changed: (state: SharedBotHostsState) => void = () => {}
// The owner's host as the share reaches it, through runtimeEnvironments: main's share gate refuses
// what isn't allowed before it is sent; a new chat started while the host is away is a placeholder there.
const call = vi.fn(
  async ({
    method,
    params
  }: {
    environmentId: string
    method: string
    params: { newChatId?: string }
  }) => {
    if (method === 'bots.chat.open' && openAnswered) {
      await openAnswered
    }
    return {
      id: method,
      ok: true,
      result:
        method === 'bots.list'
          ? { bots: [{ ...ivy, chatSessionId: theirHome }], threadReplies: false }
          : (homeAnswer(method) ?? { sessionId: params.newChatId ? 'chat-real' : 'shared-new-1' }),
      _meta: { runtimeId: SHARED.environmentId }
    }
  }
)
// The shared methods this flow asks (main's registry decides the full list).
const SHARED_METHODS = new Set([
  'bots.list',
  'bots.chat.open',
  'bots.chat.reset',
  'bots.chats',
  'bots.chats.own',
  'bots.chatTree',
  'bots.session.start',
  'agentSession.history',
  'agentSession.subscribe',
  'agentSession.subscribeStatus'
])
const environmentCall = async (request: {
  selector: string
  method: string
  params: { newChatId?: string }
}) =>
  createCompatibleRuntimeStatusResponseIfNeeded(request) ??
  (SHARED_METHODS.has(request.method)
    ? call({ environmentId: request.selector, method: request.method, params: request.params })
    : {
        id: request.method,
        ok: false,
        error: { code: 'method_not_found', message: request.method }
      })

beforeEach(async () => {
  call.mockClear()
  theirHome = null
  homesMade = 0
  openAnswered = null
  vi.stubGlobal('api', {
    ...window.api,
    sharedBotHosts: {
      list: async () => ({ hosts: [SHARED], sharing: true }),
      onChanged: (listener: (state: SharedBotHostsState) => void) => {
        changed = listener
        return () => {}
      }
    },
    runtimeEnvironments: { ...window.api?.runtimeEnvironments, call: environmentCall }
  })
  stopCatalog = installSharedBotHostCatalog()
  await Promise.resolve()
  setBotHostListing({ hosts: [{ hostId: HOST, state: 'live' }], updateNeeded: [] })
  publishBots([ivy], { threadReplies: false, webhooks: undefined }, HOST)
  resetStore()
})

afterEach(() => {
  stopCatalog()
  vi.unstubAllGlobals()
})

describe('a shared agent’s chats on this computer', () => {
  it('open in its home here, reaching the chat on its owner’s computer, and come back after a restart', async () => {
    const [bot] = readHostBots(HOST)
    expect(bot).toMatchObject({ hostId: HOST, folderWorkspaceId: 'home-1' })
    expect(openBotHome(bot)).toBe(true)
    expect(useAppStore.getState().activeWorktreeId).toBe(HOME_KEY)

    const opened = await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: HOME_KEY, sessionId: 'chat-1' }
    })
    expect(opened).toBe(true)
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: HOME_KEY, sessionId: 'chat-1' }
    })
    expect(tabs()).toEqual([
      expect.objectContaining({ entityId: 'chat-1', executionHostId: HOST, worktreeId: HOME_KEY })
    ])
    expect(structuredAgentSessionTargetForTab(useAppStore.getState(), tabs()[0])).toEqual({
      kind: 'environment',
      environmentId: SHARED.environmentId
    })

    const saved = buildWorkspaceSessionPayload(useAppStore.getState())
    resetStore()
    useAppStore.getState().hydrateTabsSession(saved)
    expect(tabs()).toEqual([
      expect.objectContaining({ entityId: 'chat-1', executionHostId: HOST, worktreeId: HOME_KEY })
    ])
  })

  it('keeps its chat tab at startup, when this computer lists the home before the shares are known', async () => {
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: true, runtimeEnvironments: [] })
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: HOME_KEY, sessionId: 'chat-1' }
    })
    // As after a restart: the tab is restored, and main hasn't said yet which agents are shared.
    stopCatalog()
    stopCatalog = () => {}
    useAppStore.setState(
      applyLocalStructuredSessionTabSnapshots(useAppStore.getState(), [
        {
          worktree: HOME_KEY,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ])
    )
    expect(tabs().map((tab) => tab.entityId)).toEqual(['chat-1'])
  })

  it('keeps its chat tab when this computer next lists the home’s own tabs', async () => {
    // The paired-server list has loaded and names no server: a shared agent's host is never on it.
    useAppStore.setState({ runtimeEnvironmentCatalogSettled: true, runtimeEnvironments: [] })
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: HOME_KEY, sessionId: 'chat-1' }
    })
    expect(tabs().map((tab) => tab.entityId)).toEqual(['chat-1'])
    // This computer lists the home with no chat of its own, as it does once a tab there changes.
    useAppStore.setState(
      applyLocalStructuredSessionTabSnapshots(useAppStore.getState(), [
        {
          worktree: HOME_KEY,
          publicationEpoch: 'epoch-1',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ])
    )
    expect(tabs().map((tab) => tab.entityId)).toEqual(['chat-1'])
  })

  it('opens its home here on this account’s own Home, reading only this computer’s workspaces', async () => {
    call.mockClear()
    const fetchFolderWorkspaces = vi.fn(async () => {})
    useAppStore.setState({ fetchFolderWorkspaces })
    const [bot] = readHostBots(HOST)
    expect(await openBotHomeTab(bot)).toBe(true)
    expect(useAppStore.getState().activeWorktreeId).toBe(HOME_KEY)
    expect(fetchFolderWorkspaces).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
    const asked = call.mock.calls.map(([request]) => request.method)
    expect(asked).not.toContain('folderWorkspaces.list')
    expect(asked).toContain('bots.chat.open')
    expect(tabs().map((tab) => tab.entityId)).toEqual(['their-home-1'])
  })

  it('closes the replaced Home’s tab here on New Home Chat, as the host does for its own', async () => {
    const [bot] = readHostBots(HOST)
    await openBotHomeTab(bot)
    expect(tabs().map((tab) => tab.entityId)).toEqual(['their-home-1'])
    expect(await newBotHomeChat(readHostBots(HOST)[0])).toBe('their-home-2')
    expect(tabs().map((tab) => tab.entityId)).not.toContain('their-home-1')
  })

  it('opens a new chat started while the owner’s computer is away, and moves it to the chat the host starts once back', async () => {
    const [bot] = readHostBots(HOST)
    changed({ hosts: [{ ...SHARED, link: 'offline' }], sharing: true })
    const placeholder = await startBotSession(bot, { agent: bot.agent })
    await activateAiVaultStructuredSession({
      structuredSession: { workspaceId: HOME_KEY, sessionId: placeholder }
    })
    expect(tabs().map((tab) => tab.entityId)).toEqual(['shared-new-1'])
    const stopSwap = installSharedBotNewChatSwap()
    changed({ hosts: [SHARED], sharing: true })
    await vi.waitFor(() =>
      expect(tabs()).toEqual([
        expect.objectContaining({ entityId: 'chat-real', executionHostId: HOST })
      ])
    )
    stopSwap()
    expect(call).toHaveBeenCalledWith({
      environmentId: SHARED.environmentId,
      method: 'bots.session.start',
      params: { botId: 'bot-1', newChatId: 'shared-new-1' }
    })
  })
})

describe('a shared agent’s page keeps this account’s Home, as a local agent’s does', () => {
  const asked = () => call.mock.calls.map(([request]) => request.method)
  afterEach(cleanup)
  const page = () => {
    useAppStore.setState({ workspaceSessionReady: true })
    return render(<BotHomeChat workspaceId={HOME_KEY} />)
  }

  it('opens it once the owner’s computer is live, never while it connects', async () => {
    setBotHostListing({ hosts: [{ hostId: HOST, state: 'connecting' }], updateNeeded: [] })
    page()
    await act(async () => {})
    expect(asked()).not.toContain('bots.chat.open')
    await act(async () => {
      setBotHostListing({ hosts: [{ hostId: HOST, state: 'live' }], updateNeeded: [] })
    })
    await vi.waitFor(() => expect(tabs().map((tab) => tab.entityId)).toEqual(['their-home-1']))
  })

  it('opens no tab for it once the page was left while the owner’s computer answered', async () => {
    let answer = (): void => {}
    openAnswered = new Promise((resolve) => (answer = resolve))
    const shown = page()
    await vi.waitFor(() => expect(asked()).toContain('bots.chat.open'))
    useAppStore.setState({ activeWorktreeId: null })
    shown.unmount()
    await act(async () => answer())
    await act(async () => {})
    expect(tabs()).toEqual([])
    expect(useAppStore.getState().activeWorktreeId).toBeNull()
  })
})
