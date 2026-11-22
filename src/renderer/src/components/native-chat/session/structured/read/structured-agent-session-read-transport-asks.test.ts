import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  watchHostContact: vi.fn(),
  supports: vi.fn()
}))

vi.mock('../../../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock(
  '../../../../../runtime/native-chat/requests/structured-agent-session-subscriptions',
  () => ({
    subscribeStructuredAgentSession: mocks.subscribe
  })
)

vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapabilities: mocks.supports
}))

vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: mocks.watchHostContact
}))

import { startStructuredAgentSessionReadTransport } from './structured-agent-session-read-transport'

type SubscribeAttempt = {
  closed: PromiseWithResolvers<{ unsubscribe: () => void }>
  onClose: () => void
  onError: (error: unknown) => void
  onEvent: (event: AgentSessionSubscribeEvent) => void
  unsubscribe: ReturnType<typeof vi.fn<() => void>>
}

const attempts: SubscribeAttempt[] = []

beforeEach(() => {
  attempts.length = 0
  vi.clearAllMocks()
  mocks.subscribe.mockImplementation((_target, _params, onEvent, onError, onClose) => {
    const attempt: SubscribeAttempt = {
      closed: Promise.withResolvers<{ unsubscribe: () => void }>(),
      onClose,
      onError,
      onEvent,
      unsubscribe: vi.fn<() => void>()
    }
    attempts.push(attempt)
    return attempt.closed.promise
  })
})

it('asks for prompt suggestions locally and from a host that takes them, never an older one', async () => {
  const read = (target: Parameters<typeof startStructuredAgentSessionReadTransport>[0]['target']) =>
    startStructuredAgentSessionReadTransport({
      subscribeRetryNow: () => () => {},
      applyEvent: vi.fn(),
      applyError: vi.fn(),
      getCursor: () => null,
      onContactLost: vi.fn(),
      onHistoryReadInvalidated: () => undefined,
      sessionId: 'session-a',
      target,
      showsPromptSuggestions: true
    })
  mocks.supports.mockImplementation(async (environmentId: string, capabilities: string[]) =>
    capabilities.map(
      (capability) =>
        environmentId === 'env-new' && capability === 'agent-session.prompt-suggestions.v1'
    )
  )
  const reads = [
    read({ kind: 'local' }),
    read({ kind: 'environment', environmentId: 'env-new' }),
    read({ kind: 'environment', environmentId: 'env-old' })
  ]
  await vi.waitFor(() => expect(attempts).toHaveLength(3))
  const asked = Object.fromEntries(
    mocks.subscribe.mock.calls.map(([target, params]) => [target.environmentId ?? 'local', params])
  )
  expect(asked).toEqual({
    // The local host ships with this renderer, so it is asked for appends without a check.
    local: {
      sessionId: 'session-a',
      capabilities: {
        promptSuggestions: 1,
        textAppend: 1,
        toolOutputAppend: 1,
        liveTextViewer: { id: expect.any(String), shown: true, seq: 1 }
      }
    },
    'env-new': { sessionId: 'session-a', capabilities: { promptSuggestions: 1 } },
    'env-old': { sessionId: 'session-a' }
  })
  reads.forEach((transport) => transport.dispose())
})
