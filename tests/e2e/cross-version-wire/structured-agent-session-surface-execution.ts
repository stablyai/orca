import { expect, vi } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
import { resetStructuredAgentSessionClosesBeforeCreateForTests } from '../../../src/main/runtime/rpc/methods/structured-agent-session-close-before-create'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import {
  attachParams,
  ATTENTION_READ,
  paramsFor,
  STRUCTURED_CALLS
} from './structured-agent-session-surface-manifest'
import type {
  AgentSessionWireBuild,
  RpcClientIdentity,
  RpcReply
} from './versioned-agent-session-wire'

export function runtimeStub(overrides: Record<string, unknown> = {}): unknown {
  // A fresh runtime remembers no chat closed before its create; scenarios reuse one session id.
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  const subscriptions = new RuntimeSubscriptionRegistry()
  return {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    ensureStructuredAgentSessionHost: async () => undefined,
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    structuredAgentSessionLaunchSeedOptions: () => undefined,
    resolveStructuredAgentSessionCreateIntent: async () => {
      const {
        envelope: _envelope,
        providerHandle: _providerHandle,
        ...resolved
      } = attachParams(null)
      return resolved
    },
    publishStructuredAgentSessionTab: () => {},
    subscribeStructuredAgentAvailability: (read: (agents: unknown[]) => void) => {
      read([])
      return () => {}
    },
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    registerOwnedSubscriptionCleanup: subscriptions.registerOwned.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    cleanupSubscriptionsByPrefix: subscriptions.cleanupByPrefix.bind(subscriptions),
    ...overrides
  }
}

// Collect every streaming reply: refusals must arrive explicitly, never as silence.
export async function callBuild(
  build: AgentSessionWireBuild,
  method: string,
  params: unknown,
  client: RpcClientIdentity,
  runtime: unknown = runtimeStub(),
  onReply?: () => void
): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build.createDispatcher(runtime).dispatchStreaming(
    { id: `request-${method}`, authToken: 'cross-version-token', method, params },
    (raw) => {
      onReply?.()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this build serializes its own reply; each caller asserts the envelope.
      replies.push(JSON.parse(raw) as RpcReply)
    },
    client
  )
  return replies
}

// Require every declared method to reach its host and return its declared result in each build pairing.
export async function expectDeclaredSurfaceExecutes(
  build: AgentSessionWireBuild,
  hostCalls: Record<string, ReturnType<typeof vi.fn>>,
  clientCapabilities: readonly string[]
): Promise<void> {
  const retirement = vi.fn()
  const runtime = runtimeStub({ retireStructuredAttention: retirement })
  if (build.methodNames.includes('agentSession.acknowledgeAttention')) {
    const before = hostCalls.publishAttentionRead.mock.calls.length
    const refused = await callBuild(
      build,
      'agentSession.acknowledgeAttention',
      ATTENTION_READ,
      {
        clientKind: 'runtime',
        clientCapabilities: clientCapabilities.filter(
          (capability) => capability !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
        )
      },
      runtime
    )
    expect(refused).toMatchObject([
      {
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      }
    ])
    expect(refused).toHaveLength(1)
    expect(retirement).not.toHaveBeenCalled()
    expect(hostCalls.publishAttentionRead.mock.calls.length).toBe(before)
  }
  for (const { method, hostMethod, result, clientCapability } of STRUCTURED_CALLS) {
    const atRestCreate =
      method === 'agentSession.create' &&
      build.capabilities.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY) &&
      clientCapabilities.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY)
    const expectedHostMethod = atRestCreate ? 'create' : hostMethod
    const otherCreateMethod =
      method === 'agentSession.create' ? (atRestCreate ? 'attach' : 'create') : null
    // Shared host methods need per-call deltas; an earlier call must not satisfy this assertion.
    const before = expectedHostMethod ? hostCalls[expectedHostMethod].mock.calls.length : 0
    const otherBefore = otherCreateMethod ? hostCalls[otherCreateMethod].mock.calls.length : 0
    const readBefore = retirement.mock.calls.length
    const publishBefore = hostCalls.publishAttentionRead.mock.calls.length
    const reply = vi.fn()
    const replies = await callBuild(
      build,
      method,
      paramsFor(method),
      { clientKind: 'runtime', clientCapabilities },
      runtime,
      reply
    )
    if (clientCapability && !clientCapabilities.includes(clientCapability)) {
      expect(replies).toMatchObject([
        {
          ok: false,
          error: { message: expect.stringContaining('structured_agent_session_unsupported') }
        }
      ])
      if (expectedHostMethod) {
        expect(hostCalls[expectedHostMethod].mock.calls.length).toBe(before)
      }
      continue
    }
    if (expectedHostMethod) {
      expect(
        hostCalls[expectedHostMethod].mock.calls.length - before,
        `${build.label}: ${method} did not reach the host: ${JSON.stringify(replies)}`
      ).toBe(1)
    }
    if (otherCreateMethod) {
      expect(hostCalls[otherCreateMethod].mock.calls.length - otherBefore).toBe(0)
    }
    if (method === 'agentSession.acknowledgeAttention') {
      expect(retirement.mock.calls.slice(readBefore)).toEqual([[ATTENTION_READ]])
      expect(hostCalls.publishAttentionRead.mock.calls.slice(publishBefore)).toEqual(
        build.publishesAttentionReads ? [[ATTENTION_READ]] : []
      )
      expect(reply).toHaveBeenCalledTimes(1)
      const retiredAt = retirement.mock.invocationCallOrder[readBefore]
      if (retiredAt === undefined) {
        throw new Error('Acknowledgment did not retire')
      }
      expect(reply.mock.invocationCallOrder[0]).toBeGreaterThan(retiredAt)
      if (build.publishesAttentionReads) {
        const publishedAt = hostCalls.publishAttentionRead.mock.invocationCallOrder[publishBefore]
        if (publishedAt === undefined) {
          throw new Error('Acknowledgment did not publish')
        }
        expect(publishedAt).toBeGreaterThan(retiredAt)
        expect(reply.mock.invocationCallOrder[0]).toBeGreaterThan(publishedAt)
      }
    }
    for (const reply of replies) {
      expect(
        reply,
        `${build.label}: ${method} was refused: ${JSON.stringify(reply)}`
      ).toMatchObject({ ok: true })
    }
    if (result) {
      // Assert the exact envelope so registered-but-failing handlers cannot pass.
      expect(replies, `${build.label}: ${method} must answer exactly once`).toHaveLength(1)
      expect(replies[0], `${build.label}: ${method} answered off-contract`).toMatchObject({
        ok: true,
        result
      })
    }
  }
}

export function expectItemDetailNegotiation(builds: readonly AgentSessionWireBuild[]): void {
  expect(builds[0]?.capabilities).toContain(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)
  for (const build of builds) {
    expect(build.capabilities.includes(AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY)).toBe(
      build.methodNames.includes('agentSession.item')
    )
  }
}
