import { beforeEach, expect, it, vi } from 'vitest'
import { useBotLinkItemTarget } from '@/lib/agent-session/open/bot-link-item-target'
import type { Bot } from '../../../../shared/bot-types'
import { openBotSession } from './bot-session-open'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, activate: vi.fn(async () => true), focus: vi.fn() }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: mocks.focus
}))
vi.mock('@/lib/bot-hosts', () => ({ callBotRpc: vi.fn(async () => undefined) }))

const bot: Bot = {
  id: 'bot-1',
  name: 'Bot',
  hostId: 'local',
  folder: 'bot',
  folderWorkspaceId: 'f1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'home',
  createdAt: 1,
  updatedAt: 1
}
const chatTab = (id: string, sessionId: string) => ({
  id,
  groupId: 'g1',
  worktreeId: 'folder:f1',
  contentType: 'agent-session',
  entityId: sessionId,
  agentSessionAgent: 'claude'
})

function showTab(active: string): void {
  Object.assign(mocks.state, {
    activeView: 'terminal',
    activeWorktreeId: 'folder:f1',
    groupsByWorktree: { 'folder:f1': [{ id: 'g1', activeTabId: active }] },
    activeGroupIdByWorktree: { 'folder:f1': 'g1' },
    unifiedTabsByWorktree: {
      'folder:f1': [chatTab('tab-a', 'chat-a'), chatTab('tab-b', 'chat-b')]
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useBotLinkItemTarget.setState({ target: null, prompt: null })
})

it('takes the chat already on screen to its newest output and focuses its composer', () => {
  showTab('tab-a')
  openBotSession(bot, 'chat-a')
  expect(useBotLinkItemTarget.getState().target).toEqual({ sessionId: 'chat-a' })
  expect(mocks.focus).toHaveBeenCalledWith('tab-a', { revealDraft: true })
  expect(mocks.activate).not.toHaveBeenCalled()
})

it('switches to a chat that is open but not on screen', () => {
  showTab('tab-b')
  openBotSession(bot, 'chat-a')
  expect(mocks.activate).toHaveBeenCalledWith({
    structuredSession: { sessionId: 'chat-a', workspaceId: 'folder:f1' }
  })
  expect(useBotLinkItemTarget.getState().target).toBeNull()
})
