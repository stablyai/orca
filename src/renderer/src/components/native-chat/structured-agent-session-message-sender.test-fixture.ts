import { vi, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

type MessageSenderFixtureMocks = {
  call: Mock
  compatible: Mock<() => Promise<void>>
  handBack: Mock<() => boolean>
}

const mocks: MessageSenderFixtureMocks = vi.hoisted(() => ({
  call: vi.fn(),
  compatible: vi.fn(async (): Promise<void> => undefined),
  handBack: vi.fn((): boolean => true)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  ensureRuntimeEnvironmentCompatible: mocks.compatible
}))
vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))

import { sendStructuredAgentSessionMessage } from './structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'

const SESSION = 'session-1'
const target = { kind: 'local' } as const

export type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

function deferredCalls(): Deferred[] {
  const calls: Deferred[] = []
  mocks.call.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        calls.push({ resolve, reject })
      })
  )
  return calls
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState'],
  extra: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the fields the sender reads.
  return { clientMessageId, dispatchState, submittedAt: 1, ...extra } as AgentJournalSubmission
}

function okSubmission(clientMessageId: string, dispatchState: 'pending' | 'accepted') {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'e', sequence: 1 },
    value: { clientMessageId, submission: submission(clientMessageId, dispatchState) }
  }
}

const refusedSend = {
  ok: false,
  refusal: { code: 'agent_session_conflict', message: 'busy', details: { reason: 'chatStarting' } }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

function send(
  text: string,
  extra: Partial<Parameters<typeof sendStructuredAgentSessionMessage>[0]> = {}
) {
  const sent = sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text, ...extra })
  if (!sent) {
    throw new Error(`refused: ${text}`)
  }
  return sent
}

function sendCalls(): number {
  return mocks.call.mock.calls.filter((call) => call[1] === 'agentSession.send').length
}

function phases(): string[] {
  return getStructuredAgentSessionPendingSends(SESSION).map(
    (entry) =>
      `${entry.body.blocks[0]?.type === 'text' ? entry.body.blocks[0].text : ''}:${entry.phase}`
  )
}

export {
  mocks,
  SESSION,
  target,
  deferredCalls,
  submission,
  okSubmission,
  refusedSend,
  flush,
  send,
  sendCalls,
  phases
}
