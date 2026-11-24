// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { Bot } from '../../../../../shared/bot-types'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import { structuredAgentSessionTargetForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { publishBots, readHostBots, setBotHostListing } from '../../bot-catalog-snapshot'
import { openBotHome, openBotHomeTab } from '../../bot-catalog'
import { buildWorkspaceSessionPayload } from '../../workspace/persistence/workspace-session'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const SHARED: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  homeWorkspaceId: 'home-1',
  link: 'live'
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

let stopCatalog: () => void = () => {}
// Main's answers over the share link, as the owner's host would give them.
const call = vi.fn(async ({ method }: { method: string }) => ({
  id: method,
  ok: true,
  result:
    method === 'bots.chat.open'
      ? { sessionId: 'chat-home' }
      : { bots: [ivy], threadReplies: false },
  _meta: { runtimeId: SHARED.environmentId }
}))

beforeEach(async () => {
  vi.stubGlobal('api', {
    ...window.api,
    sharedBotHosts: { list: async () => [SHARED], onChanged: () => () => {}, call }
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

  it('opens its Home Chat in a tab kept here, reading only this computer’s workspaces', async () => {
    call.mockClear()
    const fetchFolderWorkspaces = vi.fn(async () => {})
    useAppStore.setState({ fetchFolderWorkspaces })
    const [bot] = readHostBots(HOST)
    expect(await openBotHomeTab(bot)).toBe(true)
    expect(fetchFolderWorkspaces).toHaveBeenCalledWith({ runtimeEnvironmentId: null })
    expect(call.mock.calls.map(([request]) => request.method)).not.toContain(
      'folderWorkspaces.list'
    )
    expect(tabs()).toEqual([
      expect.objectContaining({
        entityId: 'chat-home',
        executionHostId: HOST,
        worktreeId: HOME_KEY
      })
    ])
  })
})
