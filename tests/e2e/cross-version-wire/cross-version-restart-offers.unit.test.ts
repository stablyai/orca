// A paired desktop asks a server for its restart offers on every connection and dismisses them
// there by name and listed interruption, but only where the server advertises it can: an older server builds its chat host
// to answer the read, and its strict, empty dismiss params refuse names — its only dismissal
// deletes every device's offers.

import { beforeAll, describe, expect, it } from 'vitest'
import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
import { AGENT_SESSION_PAIRED_RESTART_OFFERS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-restart-capabilities'
import { resolveBaselineReleaseRef } from './release-checkout'
import { installableHost, structuredHostStub } from './structured-agent-session-host-fixture'
import { SESSION, WORKSPACE } from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild

beforeAll(async () => {
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(resolveBaselineReleaseRef())
}, SUITE_TIMEOUT_MS)

function runtimeStub(): unknown {
  const subscriptions = new RuntimeSubscriptionRegistry()
  return {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    ensureStructuredAgentSessionHost: async () => undefined,
    registerSubscriptionCleanup: subscriptions.register.bind(subscriptions),
    registerOwnedSubscriptionCleanup: subscriptions.registerOwned.bind(subscriptions),
    cleanupSubscription: subscriptions.cleanup.bind(subscriptions),
    cleanupSubscriptionsByPrefix: subscriptions.cleanupByPrefix.bind(subscriptions)
  }
}

async function dismissNamed(
  build: AgentSessionWireBuild,
  params: Record<string, unknown> = { sessionIds: [SESSION] }
): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build.createDispatcher(runtimeStub()).dispatchStreaming(
    {
      id: 'request-dismiss',
      authToken: 'cross-version-token',
      method: 'agentSession.restartResumableDismiss',
      params
    },
    (raw) => replies.push(JSON.parse(raw)),
    { clientKind: 'runtime', clientCapabilities: current.capabilities }
  )
  return replies
}

describe('paired restart offers across versions', () => {
  // A build may accept names without advertising; it must never advertise without.
  it(
    'is advertised only where a dismiss naming chats is accepted and reaches only those',
    async () => {
      for (const build of [current, baseline]) {
        if (!build.capabilities.includes(AGENT_SESSION_PAIRED_RESTART_OFFERS_RUNTIME_CAPABILITY)) {
          continue
        }
        const hostCalls = structuredHostStub(SESSION, WORKSPACE)
        await build.installStructuredHost(installableHost(hostCalls))
        try {
          const replies = await dismissNamed(build)
          expect(replies, `${build.label}: a dismiss naming a chat`).toHaveLength(1)
          expect(replies[0], `${build.label}: a dismiss naming a chat`).toMatchObject({ ok: true })
          // Only the names are compared: a newer host also passes the caller's audience.
          expect(hostCalls.restartResumableDismiss.mock.calls[0]?.[0]).toEqual([SESSION])
          // A desktop names each chat with the interruption it listed; `sessionIds` rides along.
          const listed = [{ sessionId: SESSION, recordedAt: 1 }]
          const witnessed = await dismissNamed(build, { sessionIds: [SESSION], offers: listed })
          expect(witnessed[0], `${build.label}: a dismiss naming listed offers`).toMatchObject({
            ok: true
          })
          expect(hostCalls.restartResumableDismissListed.mock.calls[0]?.[0]).toEqual(listed)
          expect(hostCalls.restartResumableDismiss).toHaveBeenCalledTimes(1)
        } finally {
          await build.installStructuredHost(null)
        }
      }
      expect(current.capabilities).toContain(AGENT_SESSION_PAIRED_RESTART_OFFERS_RUNTIME_CAPABILITY)
    },
    SUITE_TIMEOUT_MS
  )
})
