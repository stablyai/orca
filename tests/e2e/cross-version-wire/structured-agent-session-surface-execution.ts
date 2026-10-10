import { expect, vi } from 'vitest'
import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
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
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    registerOwnedSubscriptionCleanup: subscriptions.registerOwned.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    cleanupSubscriptionsByPrefix: subscriptions.cleanupByPrefix.bind(subscriptions),
    ...overrides
  }
}

/** Every reply one call produced. Streaming methods answer more than once, and a
 *  refusal has to arrive as a reply rather than as silence. */
export async function callBuild(
  build: AgentSessionWireBuild,
  method: string,
  params: unknown,
  client: RpcClientIdentity,
  runtime: unknown = runtimeStub()
): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build.createDispatcher(runtime).dispatchStreaming(
    { id: `request-${method}`, authToken: 'cross-version-token', method, params },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the build's RPC dispatcher serializes its own reply; result/error shape is asserted by each surface case.
    (raw) => replies.push(JSON.parse(raw) as RpcReply),
    client
  )
  return replies
}

/**
 * The one thing this suite exists to guarantee, written once and applied per
 * build: every method the manifest declares is not merely registered but reaches
 * its host method on this call, answers, and answers with its declared result.
 *
 * Written as a helper rather than inline because a build passing it is the claim,
 * and each skew that registers the surface owes the same claim — a check that
 * covers one method leaves the rest registered-but-unusable behind a green suite.
 */
export async function expectDeclaredSurfaceExecutes(
  build: AgentSessionWireBuild,
  hostCalls: Record<string, ReturnType<typeof vi.fn>>,
  clientCapabilities: readonly string[]
): Promise<void> {
  const retirement = vi.fn()
  const runtime = runtimeStub({ retireStructuredAttention: retirement })
  for (const { method, hostMethod, result } of STRUCTURED_CALLS) {
    // Two methods share one host method, so "has been called" would already be
    // true from the earlier one: only this call's own delta pins the pairing.
    const before = hostMethod ? hostCalls[hostMethod].mock.calls.length : 0
    const replies = await callBuild(
      build,
      method,
      paramsFor(method),
      { clientKind: 'runtime', clientCapabilities },
      runtime
    )
    if (hostMethod) {
      expect(
        hostCalls[hostMethod].mock.calls.length - before,
        `${build.label}: ${method} did not reach the host`
      ).toBe(1)
    }
    if (method === 'agentSession.acknowledgeAttention') {
      expect(retirement).toHaveBeenCalledExactlyOnceWith(ATTENTION_READ)
    }
    for (const reply of replies) {
      expect(
        reply,
        `${build.label}: ${method} was refused: ${JSON.stringify(reply)}`
      ).toMatchObject({ ok: true })
    }
    if (result) {
      // The declared answer, not merely a non-refusal: a handler that is
      // registered and returns an execution error, or hands back someone else's
      // envelope, fails here rather than passing as "reached the host".
      expect(replies, `${build.label}: ${method} must answer exactly once`).toHaveLength(1)
      expect(replies[0], `${build.label}: ${method} answered off-contract`).toMatchObject({
        ok: true,
        result
      })
    }
  }
}
