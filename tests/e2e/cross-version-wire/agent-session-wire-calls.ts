// How the cross-version suites call one build's agent-session dispatcher: a runtime stub that has
// what the structured methods read, and every reply a call produced.

import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
import { attachParams } from './structured-agent-session-surface-manifest'
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
  await build
    .createDispatcher(runtime)
    .dispatchStreaming(
      { id: `request-${method}`, authToken: 'cross-version-token', method, params },
      (raw) => replies.push(JSON.parse(raw) as RpcReply),
      client
    )
  return replies
}
