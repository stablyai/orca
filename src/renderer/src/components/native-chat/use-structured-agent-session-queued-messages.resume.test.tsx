// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'

import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'

import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'

import type { QueuedEditTransport } from './use-structured-agent-session-queued-edit'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

// Resume uses the shared fenced write path; serialize presses, show one failure toast and keep Resume as the retry.

type ResumeParams = { envelope: { clientOperationId: string } }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: ResumeParams) => Promise<unknown>>(),
  toastError: vi.fn(),
  updateSettings: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender: vi.fn() }))
vi.mock('@/runtime/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => null
}))
vi.mock('../../store', () => {
  const state = { updateSettings: mocks.updateSettings }
  const useAppStore = (selector: (value: typeof state) => unknown): unknown => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

const NO_EDIT: QueuedEditTransport = {
  target: { kind: 'local' },
  sessionId: 'session',
  capable: false,
  write: async () => ({ kind: 'dropped' })
}

const RESUMED = {
  ok: true,
  replayed: false,
  fence: 1,
  cursor: { epoch: 'epoch-1', sequence: 1 },
  value: { resumed: true }
}

function card(
  messageId: string,
  fields: Partial<AgentSessionQueuedMessage> = {}
): AgentSessionQueuedMessage {
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  return { messageId, position: 1, body, state: 'waiting', ...fields }
}

type ControllerInput = {
  queuedMessages?: AgentSessionQueuedMessage[]
  queuePause?: AgentSessionQueuePause | null
  submissions?: AgentJournalSubmission[]
  sending?: StructuredAgentSessionPendingSend[]
  isWorking?: boolean
}

function renderController(initialProps: ControllerInput = {}) {
  const stateRef = { current: { fence: 1 } }
  return renderHook(
    (input: ControllerInput) => {
      const { mutate, write, admit, capturePresentation } = useStructuredAgentSessionMutate({
        sessionId: 'session-1',
        target: { kind: 'local' },
        stateRef
      })
      return useStructuredAgentSessionQueuedMessages({
        enabled: true,
        queuedMessages: input.queuedMessages ?? [card('held')],
        queuePause: input.queuePause === undefined ? { reason: 'stopped' } : input.queuePause,
        submissions: input.submissions ?? [],
        hasPendingPrompt: false,
        isWorking: input.isWorking ?? false,
        sending: input.sending,
        composerScopeKey: undefined,
        mutate,
        admit,
        capturePresentation,
        editTransport: { ...NO_EDIT, write }
      })
    },
    { initialProps }
  )
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('Resume on a held queue', () => {
  it('a second press while one is in flight sends nothing', async () => {
    const answer = Promise.withResolvers<unknown>()
    mocks.call.mockReturnValueOnce(answer.promise)
    const { result } = renderController()
    let pending: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pending = result.current.resume()
    })
    expect(result.current.queuePending).toBe('resume')
    await act(() => result.current.resume())
    expect(mocks.call).toHaveBeenCalledTimes(1)
    await act(async () => {
      answer.resolve(RESUMED)
      await pending
    })
    expect(result.current.queuePending).toBeNull()
  })
})
