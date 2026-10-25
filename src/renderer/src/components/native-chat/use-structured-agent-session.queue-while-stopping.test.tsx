// @vitest-environment happy-dom

// Without host queue support, sends during Stopping go out plain and render after the Stop line while the host holds delivery.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
let items: AgentJournalRenderItem[] = []
const submissions: AgentJournalSubmission[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: { fence: 3, items, submissions, status: 'ready', error: null, hasOlder: false },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

import { AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

function sends(): { delivery?: string; body?: unknown }[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.send')
    .map(([, , params]) => params)
}

beforeEach(() => {
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
  items = [RUNNING_TURN]
  // Model a host without queued-message support.
  setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
  // Hold send replies while Stop occupies the host lane.
  mocks.call.mockImplementation(() => new Promise(() => {}))
})

afterEach(() => {
  cleanup()
  // The sender is module-wide: a send still out would refuse the next test's.
  resetStructuredAgentSessionSendsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
  mocks.call.mockReset()
})

function renderStopping() {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true,
      composerScopeKey: 'scope-1',
      queueFollowUps: false,
      hostStopping: true
    })
  )
}

it('sends plain where the host does not queue sends, marked as sent while stopping', async () => {
  const { result } = renderStopping()

  expect(result.current.send('run this after the stop')).toBe(true)

  await waitFor(() => expect(sends()).toHaveLength(1))
  expect(sends()[0]).not.toHaveProperty('delivery')
  expect(
    result.current.messages.find((message) =>
      JSON.stringify(message.blocks).includes('run this after the stop')
    )
  ).toMatchObject({ role: 'user', sentWhileStopping: true })
})

it('does not mark a send made before the chat read Stopping', async () => {
  const { result, rerender } = renderHook(
    ({ hostStopping }: { hostStopping: boolean }) =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true,
        composerScopeKey: 'scope-1',
        queueFollowUps: false,
        hostStopping
      }),
    { initialProps: { hostStopping: false } }
  )
  expect(result.current.send('sent before the stop')).toBe(true)

  rerender({ hostStopping: true })

  await waitFor(() => expect(sends()).toHaveLength(1))
  const sent = result.current.messages.find((message) =>
    JSON.stringify(message.blocks).includes('sent before the stop')
  )
  expect(sent).toBeDefined()
  expect(sent).not.toHaveProperty('sentWhileStopping')
})
