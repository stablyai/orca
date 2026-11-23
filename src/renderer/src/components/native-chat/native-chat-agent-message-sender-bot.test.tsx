// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { foldAgentSessionConversationNames } from '../../../../shared/agent-session/conversation-naming/agent-session-conversation-names'
import type { AgentMessageSource } from '../../../../shared/agent-session/journal/agent-session-message-source'
import { BotSchema, type Bot } from '../../../../shared/bot-types'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatAgentMessageSenders } from './messages/agent-senders/NativeChatAgentMessageSenders'

const SENDER_CHAT = testOrcaSessionId('triage-home-chat')
const HOME = folderWorkspaceKey('triage-home')
const names = foldAgentSessionConversationNames(new Map(), {
  type: 'snapshot',
  sessions: [
    {
      sessionId: SENDER_CHAT,
      workspaceId: HOME,
      agent: 'claude',
      status: null,
      latestPrompt: '',
      updatedAt: 1
    }
  ],
  conversationNames: [{ sessionId: SENDER_CHAT, conversationName: 'Home' }]
})
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    activate: () => () => {},
    getSnapshot: () => new Map(),
    getNamingSnapshot: () => names,
    getSessionObservation: () => 'live',
    subscribe: () => () => {},
    subscribeSession: () => () => {}
  })
}))
vi.mock('@/lib/agent-session/open/open-agent-message-sender', () => ({
  openAgentMessageSender: vi.fn()
}))
const catalog = vi.hoisted((): { bots: Bot[] } => ({ bots: [] }))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: (enabled = true) => (enabled ? catalog.bots : []),
  useBotsEnabled: () => true,
  readBots: () => catalog.bots,
  readBotsEnabled: () => true
}))

const initial = useAppStore.getInitialState()
const homeTab: Tab = {
  id: `tab-${SENDER_CHAT}`,
  entityId: SENDER_CHAT,
  worktreeId: HOME,
  groupId: 'g',
  contentType: 'agent-session',
  executionHostId: 'local',
  label: 'Home',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: [
    {
      party: {
        address: `orca_session_id:${SENDER_CHAT}`,
        terminalHandle: null,
        orcaSessionId: SENDER_CHAT
      },
      name: 'Home'
    }
  ]
}

beforeEach(() => {
  catalog.bots = []
  useAppStore.setState(
    {
      ...initial,
      activeWorktreeId: 'recipient',
      activeWorkspaceExecutionHostId: 'local',
      unifiedTabsByWorktree: { [HOME]: [homeTab] }
    },
    true
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it("names a chat in a bot's home by its bot, not by the chat's own name", () => {
  catalog.bots = [
    BotSchema.parse({
      id: 'triage',
      name: 'Triage bot',
      folder: 'triage',
      folderWorkspaceId: 'triage-home',
      agent: 'claude',
      hostId: 'local',
      avatar: null,
      paused: false,
      slack: null,
      members: [],
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      chatSessionId: SENDER_CHAT,
      createdAt: 1,
      updatedAt: 1
    })
  ]
  render(<NativeChatAgentMessageSenders from={from} chatWorktreeId="recipient" />)
  expect(screen.getByText('Triage bot')).toBeInTheDocument()
  expect(screen.queryByText('Home')).toBeNull()
})

it('keeps the chat name for a chat outside any bot home', () => {
  render(<NativeChatAgentMessageSenders from={from} chatWorktreeId="recipient" />)
  expect(screen.getByText('Home')).toBeInTheDocument()
})
