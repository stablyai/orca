import { expect, it } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type { StructuredAgentSessionFirstMessage } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import {
  retainedOpeningCreateParams,
  structuredLaunchFirstMessageUnsendable
} from './structured-agent-session-launch-first-message-policy'

// Nothing is stood in: the create envelope builder, its digest and the outbound policy run for real.
const SESSION = 'retained-opening'

/** A recorded opening as an earlier build saved it, with `firstMessage` as its first send. */
function retainedOpening(firstMessage?: StructuredAgentSessionFirstMessage) {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION,
    worktree: 'id:wt',
    agent: 'codex',
    randomUuid: () => '00000000-0000-4000-8000-000000000000',
    now: 1_700_000_000_000,
    ...(firstMessage ? { firstMessage } : {})
  })
}

const message = (text: string, path?: string): StructuredAgentSessionFirstMessage => ({
  clientMessageId: 'first',
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }, ...(path ? [{ type: 'image-ref' as const, path }] : [])]
  }
})

// D11-06 / C15-06. Explicit Retry of a retained opening is a new create operation. Its historical first
// message names a browser file, so it is not reissued: the chat is created empty, under the new id,
// with the digest of exactly what is sent.
it('creates a retained opening empty when its first message names a browser file', () => {
  const params = retainedOpening(message('see [Image #1]', 'orca-browser-file:old/shot.png'))
  expect(structuredLaunchFirstMessageUnsendable(params)).toBe(true)

  const retried = retainedOpeningCreateParams(SESSION, params, 'retry-op')

  expect(retried.firstMessage).toBeUndefined()
  expect(retried.envelope.clientOperationId).toBe('retry-op')
  expect(retried.envelope.payloadFingerprint).toBe(
    structuredAgentSessionCreateFingerprint({ sessionId: SESSION, ...retried })
  )
  expect(retried.envelope.payloadFingerprint).toBe(retainedOpening().envelope.payloadFingerprint)
  expect(structuredLaunchFirstMessageUnsendable(retried)).toBe(false)
})

// The control: a sendable retained first message is reissued exactly, digest unchanged.
it('reissues a retained opening whose first message may leave, unchanged', () => {
  const params = retainedOpening(
    message('see [Image #1]', '/host/agent-session-attachments/u/shot.png')
  )
  expect(structuredLaunchFirstMessageUnsendable(params)).toBe(false)

  const retried = retainedOpeningCreateParams(SESSION, params, 'retry-op')

  expect(retried.firstMessage).toEqual(params.firstMessage)
  expect(retried.envelope).toEqual({ ...params.envelope, clientOperationId: 'retry-op' })
})

// A clean empty-chat create has no first message to refuse, and a zero-block one is refused too.
it('admits an empty-chat create and refuses a zero-block first message', () => {
  expect(structuredLaunchFirstMessageUnsendable(retainedOpening())).toBe(false)
  expect(
    structuredLaunchFirstMessageUnsendable({
      firstMessage: { clientMessageId: 'x', body: { kind: 'message', role: 'user', blocks: [] } }
    })
  ).toBe(true)
})
