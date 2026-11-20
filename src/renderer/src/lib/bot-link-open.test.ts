import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { publishBots, setBotHostListing } from './bot-catalog-snapshot'
import { openAccessRequestLink, openBotLinkHome } from './bot-link-open'

const mocks = vi.hoisted(() => ({
  openBotHomeTab: vi.fn(async () => true),
  redeem: vi.fn(),
  review: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  activateChat: vi.fn(async () => true),
  fetchFolderWorkspaces: vi.fn(async () => {})
}))
vi.mock('./agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activateChat
}))
// The server bot's home as its server lists it, linked to one Slack thread.
const SERVER_HOME = {
  id: 'fw-triage',
  executionHostId: 'runtime:m4',
  externalConversations: [{ source: 'slack', externalId: 'T1:C1:1', sessionId: 'thread-chat' }]
}

vi.mock('./bot-catalog', () => ({
  openBotHomeTab: mocks.openBotHomeTab,
  refreshBots: async () => {}
}))
vi.mock('./bot-access-requests', () => ({ reviewAccessRequest: mocks.review }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (target: unknown, method: string) =>
    method === 'bots.access.redeem' ? mocks.redeem(target) : Promise.reject(new Error(method))
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      fetchFolderWorkspaces: mocks.fetchFolderWorkspaces,
      folderWorkspaces: [SERVER_HOME],
      runtimeEnvironments: [
        { id: 'm4', name: 'm4 air' },
        { id: 'linux', name: 'linux 1' }
      ]
    })
  }
}))
vi.mock('sonner', () => ({ toast: { info: mocks.info, error: mocks.error } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

function bot(id: string): Bot {
  return {
    id,
    name: id,
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

beforeEach(() => {
  vi.clearAllMocks()
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:m4', state: 'live' }
    ],
    updateNeeded: []
  })
  publishBots([bot('mine')], { threadReplies: false, webhooks: undefined }, 'local')
  publishBots([bot('triage')], { threadReplies: false, webhooks: undefined }, 'runtime:m4')
})

describe('openBotLinkHome', () => {
  it("opens the server's chat for a server bot's thread, read fresh from that server", async () => {
    await openBotLinkHome('triage', { source: 'slack', externalId: 'T1:C1:1' })
    expect(mocks.fetchFolderWorkspaces).toHaveBeenCalledWith({ runtimeEnvironmentId: 'm4' })
    expect(mocks.activateChat).toHaveBeenCalledWith(
      { structuredSession: { workspaceId: 'folder:fw-triage', sessionId: 'thread-chat' } },
      undefined,
      { kind: 'environment', environmentId: 'm4' }
    )
    expect(mocks.openBotHomeTab).not.toHaveBeenCalled()
  })

  it("opens a server bot's Home for a bare link", async () => {
    await openBotLinkHome('triage', null)
    expect(mocks.activateChat).not.toHaveBeenCalled()
    expect(mocks.openBotHomeTab).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'triage', hostId: 'runtime:m4' })
    )
  })

  // A thread whose message never reached the computer has no chat; its bot's Home is a different one.
  it('opens no Home for a thread no computer has a chat for', async () => {
    await openBotLinkHome('mine', { source: 'slack', externalId: 'T1:C1:1' })
    await openBotLinkHome('triage', { source: 'slack', externalId: 'T1:C1:2' })
    expect(mocks.activateChat).not.toHaveBeenCalled()
    expect(mocks.openBotHomeTab).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledTimes(2)
  })
})

describe('openAccessRequestLink', () => {
  it('reviews the request on the computer that took the token', async () => {
    const request = { requestId: 'req-1', botId: 'triage' }
    mocks.redeem
      .mockResolvedValueOnce({ kind: 'not-here' })
      .mockResolvedValueOnce({ kind: 'redeemed', botId: 'triage', request })
    await openAccessRequestLink('tok')
    expect(mocks.redeem.mock.calls).toEqual([
      [{ kind: 'local' }],
      [{ kind: 'environment', environmentId: 'm4' }]
    ])
    expect(mocks.review).toHaveBeenCalledWith({ ...request, hostId: 'runtime:m4' })
  })

  it('names a disconnected server when no connected one has the request', async () => {
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: 'runtime:m4', state: 'offline' }
      ],
      updateNeeded: []
    })
    mocks.redeem.mockResolvedValueOnce({ kind: 'not-here' })
    await openAccessRequestLink('tok')
    expect(mocks.redeem).toHaveBeenCalledTimes(1)
    expect(mocks.review).not.toHaveBeenCalled()
    expect(mocks.info).toHaveBeenCalledWith(
      "Couldn't reach m4 air. The bot may be there; open the link again once it's back."
    )
  })
})
