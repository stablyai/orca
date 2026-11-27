import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { Bot } from '../../../../../../shared/bot-types'
import type { StructuredTab } from '../status/structured-agent-session-tabs'

type Mocks = {
  // The catalog's bots: only the fields the Home and silencing checks read.
  bots: readonly Pick<
    Bot,
    'id' | 'hostId' | 'folderWorkspaceId' | 'chatSessionId' | 'notifications'
  >[]
  delivered: ReturnType<typeof vi.fn>
  emit: ((event: AgentSessionStatusEvent) => void) | null
}
const mocks = vi.hoisted((): Mocks => ({ bots: [], delivered: vi.fn(), emit: null }))

vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readBots: () => mocks.bots
}))
// The host's status stream, as the wire delivers it.
vi.mock(
  '@/runtime/native-chat/requests/structured-agent-session-subscriptions',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    subscribeStructuredAgentSessionStatus: async (
      _target: unknown,
      onEvent: (event: AgentSessionStatusEvent) => void
    ) => {
      mocks.emit = onEvent
      return { unsubscribe: () => {} }
    }
  })
)
// The OS notification, where the label ends up.
vi.mock('@/attention/agent-attention-notification-delivery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deliverAgentAttentionNotification: mocks.delivered
}))

import { useAppStore } from '@/store'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { dispatchStructuredTurnCompletionAttention } from './structured-attention-dispatch'

const WORKSPACE = 'folder:home'
const OWN_HOME = '11111111-1111-4111-8111-111111111111'
const ALICE_HOME = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  mocks.delivered.mockReset()
})

function homeTab(sessionId: string): StructuredTab {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch reads only these tab fields.
  return {
    id: `tab-${sessionId}`,
    entityId: sessionId,
    worktreeId: WORKSPACE,
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex'
  } as StructuredTab
}

async function notifiedTitle(tab: StructuredTab): Promise<unknown> {
  dispatchStructuredTurnCompletionAttention(tab, {
    scope: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'folder'
    },
    sessionId: tab.entityId,
    turnId: `turn-${tab.entityId}`,
    outcome: 'success',
    completedAt: 1
  })
  await vi.waitFor(() => expect(mocks.delivered).toHaveBeenCalled())
  return mocks.delivered.mock.calls.at(-1)?.[0]?.terminalTitle
}

it('titles a teammate’s Home notification by the host’s name, and the viewer’s own as Home', async () => {
  mocks.bots = [
    {
      id: 'bot-1',
      hostId: 'local',
      folderWorkspaceId: 'home',
      chatSessionId: OWN_HOME,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true }
    }
  ]
  const tabs = [homeTab(OWN_HOME), homeTab(ALICE_HOME)]
  useAppStore.setState({ unifiedTabsByWorktree: { [WORKSPACE]: tabs } })
  // The host names Alice's Home, as its record store titles it.
  getStructuredAgentSessionStatusFeed(structuredAgentSessionTargetForHost('local')!).activate()
  await vi.waitFor(() => expect(mocks.emit).not.toBeNull())
  mocks.emit!({
    type: 'snapshot',
    sessions: [],
    conversationNames: [
      { sessionId: ALICE_HOME, conversationName: 'Alice’s Home' },
      { sessionId: OWN_HOME, conversationName: 'Fix the build' }
    ]
  })
  expect(await notifiedTitle(tabs[1])).toBe('Alice’s Home')
  expect(await notifiedTitle(tabs[0])).toBe('Home')
})
