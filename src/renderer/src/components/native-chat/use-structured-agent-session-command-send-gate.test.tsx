// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outboxSend: vi.fn()
}))
let items: AgentJournalRenderItem[] = []
let backgroundTasks: AgentSessionBackgroundTaskState | undefined

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      handoff: null,
      ...(backgroundTasks ? { backgroundTasks } : {})
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./structured-agent-session-operation-id', () => ({
  structuredSessionOperationId: () => 'operation-1'
}))
vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: mocks.outboxSend,
    stopSends: vi.fn()
  })
}))

import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../../../shared/agent-session-background-task-wire'
import { useStructuredAgentSession } from './use-structured-agent-session'

function answer(text: string, scoped: boolean): AgentJournalRenderItem {
  return {
    itemId: text,
    revision: 0,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    ...(scoped ? { turnScope: { kind: 'thread' as const } } : {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.outboxSend.mockReturnValue(true)
  backgroundTasks = undefined
})

/** Starts `/compact` and leaves its reply outstanding, then sends a message. */
function sendDuringCommand(): boolean | 'queued' {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.conversationCommand' ? new Promise(() => {}) : Promise.resolve(null)
  )
  const { result } = renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'codex',
      target: { kind: 'local' },
      isVisible: true
    })
  )
  act(() => {
    void result.current.runConversationCommand('compact')
  })
  return result.current.send('typed during the command')
}

it('still refuses a message locally while an older host runs a command', () => {
  items = [answer('from an older host', false)]

  expect(sendDuringCommand()).toBe(false)
  expect(mocks.outboxSend).not.toHaveBeenCalled()
})

it('queues a message typed during a command on a host that runs it as a turn', () => {
  items = [answer('from this host', true)]

  expect(sendDuringCommand()).toBe(true)
  expect(mocks.outboxSend).toHaveBeenCalledOnce()
})

// What a refused /clear names goes from the chat with its cause, so its line can go too.
describe('a /clear refused for something the chat shows', () => {
  const renderSession = () =>
    renderHook(() =>
      useStructuredAgentSession({
        sessionId: 'session-1',
        agent: 'codex',
        target: { kind: 'local' },
        isVisible: true
      })
    )
  async function clear(result: { current: ReturnType<typeof useStructuredAgentSession> }) {
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    return outcome
  }

  it('while the agent works: named working, which ends when the agent stops', async () => {
    items = [
      {
        itemId: 'turn-1',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
      }
    ]
    const { result, rerender } = renderSession()
    expect(await clear(result)).toEqual({
      accepted: false,
      error: "Codex is still working. Run /clear when it's done.",
      refusedWhile: 'working'
    })
    expect(result.current.commandRefusalCauses.working).toBe(true)
    items = []
    rerender()
    expect(result.current.commandRefusalCauses.working).toBe(false)
    expect(
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.conversationCommand')
    ).toHaveLength(0)
  })

  it('while background tasks run: named background, which ends with the last task', async () => {
    items = []
    backgroundTasks = { state: 'monitoring', tasks: [{ id: 'task-1', kind: 'command' }] }
    const { result, rerender } = renderSession()
    expect(await clear(result)).toMatchObject({ accepted: false, refusedWhile: 'background' })
    expect(result.current.commandRefusalCauses.background).toBe(true)
    backgroundTasks = undefined
    rerender()
    expect(result.current.commandRefusalCauses.background).toBe(false)
  })
})
