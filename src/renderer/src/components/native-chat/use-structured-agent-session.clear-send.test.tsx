// @vitest-environment happy-dom

// A /clear moves the chat to a new conversation, and its host refuses a send made meanwhile. Text
// typed during it stays in the box: it is never sent into that refusal.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

// Turn-scoped rows: a host that runs a /compact as a turn, so only a /clear holds sends back.
const ANSWER: AgentJournalRenderItem = {
  itemId: 'answer',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] },
  turnScope: { kind: 'thread' }
}

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: [ANSWER],
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

import { AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS } from '../../../../shared/agent-session-conversation-command'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { structuredAgentSessionSendOut } from './structured-agent-session-pending-sends'
import {
  clearNativeChatComposerDraftsForTests,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'

const CONVERSATION_IN_FLIGHT = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    message: 'Wait for the conversation operation to finish.',
    details: { reason: 'conversationCommandInFlight' }
  }
}

type Deferred = { resolve: (value: unknown) => void }

function hostWithAClearOut(): Deferred[] {
  const clears: Deferred[] = []
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method === 'agentSession.conversationCommand') {
      return new Promise((resolve) => clears.push({ resolve }))
    }
    if (method === 'agentSession.send') {
      return Promise.resolve(CONVERSATION_IN_FLIGHT)
    }
    return Promise.resolve(null)
  })
  return clears
}

function view(sessionId: string) {
  return renderHook(
    ({ id }) =>
      useStructuredAgentSession({
        sessionId: id,
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true,
        composerScopeKey: structuredAgentSessionDraftScopeKey(id)
      }),
    { initialProps: { id: sessionId } }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearNativeChatComposerDraftsForTests()
})

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
})

function cleared(replacementSessionId?: string) {
  return {
    ok: true,
    replayed: false,
    fence: 3,
    cursor: { epoch: 'e', sequence: 2 },
    value: {
      command: 'clear',
      state: 'completed',
      ...(replacementSessionId ? { replacementSessionId } : {})
    }
  }
}

it('takes no send while a /clear is out: the text stays in the box and nothing is sent', async () => {
  const clears = hostWithAClearOut()
  const { result } = view('session-a')
  act(() => {
    void result.current.runConversationCommand('clear')
  })
  await act(async () => {})
  expect(result.current.sendOut).toBe(true)
  expect(structuredAgentSessionSendOut('session-a')).toBe(true)

  let sent: boolean | 'queued' = true
  act(() => {
    sent = result.current.send('c4 during clear')
  })
  await act(async () => {})
  expect(sent).toBe(false)
  expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.send')).toBe(false)

  // A /clear that did not move the chat gives the slot back.
  await act(async () => {
    clears[0].resolve(cleared())
  })
  expect(result.current.sendOut).toBe(false)
})

it('keeps a conversation a /clear moved away from taking no send until the view leaves it', async () => {
  const clears = hostWithAClearOut()
  const { result, rerender } = view('session-a')
  act(() => {
    void result.current.runConversationCommand('clear')
  })
  await act(async () => {
    clears[0].resolve(cleared('session-b'))
  })
  // Its host refuses the old conversation now; the chat shows the new one once its tab moves.
  expect(result.current.sendOut).toBe(true)
  expect(structuredAgentSessionSendOut('session-a')).toBe(true)

  rerender({ id: 'session-b' })
  expect(structuredAgentSessionSendOut('session-a')).toBe(false)
  expect(result.current.sendOut).toBe(false)
})

it('gives the old conversation back when its view unmounted before the /clear that moved it answered', async () => {
  const clears = hostWithAClearOut()
  const { result, unmount } = view('session-a')
  act(() => {
    void result.current.runConversationCommand('clear')
  })
  await act(async () => {})
  unmount()
  await act(async () => {
    clears[0].resolve(cleared('session-b'))
  })
  expect(structuredAgentSessionSendOut('session-a')).toBe(false)
  expect(view('session-a').result.current.sendOut).toBe(false)
})

it('gives the slot back when the host refuses the /clear, or its call fails', async () => {
  for (const answer of [
    () => Promise.resolve(CONVERSATION_IN_FLIGHT),
    () => Promise.reject(new Error('connection closed'))
  ]) {
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.conversationCommand' ? answer() : Promise.resolve(null)
    )
    const { result, unmount } = view('session-a')
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    expect(structuredAgentSessionSendOut('session-a')).toBe(false)
    expect(result.current.sendOut).toBe(false)
    unmount()
  }
})

it('holds nothing for a /compact, which the host runs as a turn with sends queued behind it', async () => {
  hostWithAClearOut()
  const { result } = view('session-a')
  act(() => {
    void result.current.runConversationCommand('compact')
  })
  await act(async () => {})
  expect(result.current.sendOut).toBe(false)
})

// The local call has no deadline of its own: a /clear that never answers must not keep Send off.
it('takes sends again once a /clear that never answers passes its deadline', async () => {
  vi.useFakeTimers()
  try {
    hostWithAClearOut()
    const { result } = view('session-a')
    act(() => {
      void result.current.runConversationCommand('clear')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS - 1)
    })
    expect(result.current.sendOut).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(structuredAgentSessionSendOut('session-a')).toBe(false)
    expect(result.current.sendOut).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
