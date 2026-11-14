// @vitest-environment happy-dom
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { foldAgentSessionConversationNames } from '../../../../../../shared/agent-session/agent-session-conversation-names'
import type { AgentSessionConversationNames } from '../../../../../../shared/agent-session/agent-session-conversation-names'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'
import type {
  AgentSessionConversationName,
  AgentSessionStatusSummary
} from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/agent-session-message-source'
import type { Tab } from '../../../../../../shared/tab-types'

const feeds = vi.hoisted(
  () =>
    new Map<
      string,
      {
        snapshot: ReadonlyMap<string, AgentSessionStatusSummary>
        names: AgentSessionConversationNames
        listeners: Set<() => void>
        live: boolean
        activations: number
      }
    >()
)
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: { kind: string; environmentId?: string }) => {
    const feed = feeds.get(target.environmentId ?? 'local')!
    return {
      activate: () => {
        feed.activations++
        return () => {
          feed.activations--
        }
      },
      getSnapshot: () => feed.snapshot,
      getNamingSnapshot: () => feed.names,
      getSessionObservation: () => (feed.live ? 'live' : 'unverifiable'),
      subscribe: (listener: () => void) => {
        feed.listeners.add(listener)
        return () => {
          feed.listeners.delete(listener)
        }
      },
      subscribeSession: (_sessionId: string, listener: () => void) => {
        feed.listeners.add(listener)
        return () => {
          feed.listeners.delete(listener)
        }
      }
    }
  }
}))
const openAgentMessageSender = vi.hoisted(() => vi.fn())
vi.mock('@/lib/agent-session/open/open-agent-message-sender', () => ({ openAgentMessageSender }))

const ROOT = testOrcaSessionId('root-chat')
const RECIPIENT = 'recipient'
const SENDER = 'sender'
void 'terminal:11111111-1111-4111-8111-111111111111'
const initial = useAppStore.getInitialState()
void { key: 'session_id' as const, id: 'provider-a' }

function summary(sessionId: string): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: SENDER,
    agent: 'claude',
    status: null,
    latestPrompt: '',
    updatedAt: 1
  }
}
function tab(sessionId: string, name: string, host: 'local' | 'runtime:remote' = 'local'): Tab {
  return {
    id: `tab-${host}-${sessionId}`,
    entityId: sessionId,
    worktreeId: SENDER,
    groupId: 'g',
    contentType: 'agent-session',
    executionHostId: host,
    label: 'Claude Chat',
    customLabel: name,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function source(terminal = false): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: null,
    senders: [
      {
        party: {
          address: terminal ? 'term-a' : `orca_session_id:${ROOT}`,
          terminalHandle: terminal ? 'term-a' : null,
          orcaSessionId: terminal ? null : ROOT
        },
        name: 'Original sender'
      }
    ]
  }
}
function publish(
  host: string,
  summaries?: AgentSessionStatusSummary[],
  conversationNames: AgentSessionConversationName[] = []
): void {
  const feed = feeds.get(host)!
  if (summaries) {
    feed.snapshot = new Map(summaries.map((row) => [row.sessionId, row]))
  }
  feed.names = foldAgentSessionConversationNames(feed.names, {
    type: 'snapshot',
    sessions: summaries ?? [],
    conversationNames
  })
  for (const listener of feed.listeners) {
    listener()
  }
}

beforeEach(() => {
  openAgentMessageSender.mockClear()
  feeds.set('local', {
    snapshot: new Map([[ROOT, summary(ROOT)]]),
    names: new Map(),
    listeners: new Set(),
    live: true,
    activations: 0
  })
  useAppStore.setState(
    { ...initial, activeWorktreeId: RECIPIENT, activeWorkspaceExecutionHostId: 'local' },
    true
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  feeds.clear()
})

it('uses the same published /clear successor for the live sender label', () => {
  const live = testOrcaSessionId('22222222-2222-4222-8222-222222222222')
  publish('local', [summary(live)], [{ sessionId: live, conversationName: 'Continued sender' }])
  useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab(live, '')] } })
  useAppStore.getState().setAgentSenderPublication('local', {
    associations: [
      {
        identity: `orca_session_id:${ROOT}`,
        sessionId: live,
        paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(live), live),
        worktreeId: SENDER
      }
    ],
    principals: [],
    attachments: [],
    revision: { epoch: 'host', revision: 1 }
  })
  render(<NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} />)
  expect(screen.getByText('Continued sender')).toBeInTheDocument()
})
