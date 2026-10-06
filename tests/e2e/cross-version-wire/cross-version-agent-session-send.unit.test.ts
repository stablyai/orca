// A current client's `agentSession.send`, built by the outbox clients send from, against a real
// published release. The release's schema must take it and its admission must re-derive the
// fingerprint the client declared: a send it rejects, or digests differently and refuses as an
// operation conflict, loses the user's message.

import { beforeAll, describe, expect, it } from 'vitest'
import { resolveBaselineReleaseRef } from './release-checkout'
import { installableHost, structuredHostStub } from './structured-agent-session-host-fixture'
import {
  resetOperationIds,
  sendParams,
  SESSION,
  WORKSPACE
} from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply,
  type SentMessage
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild

beforeAll(async () => {
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(resolveBaselineReleaseRef())
}, SUITE_TIMEOUT_MS)

async function send(build: AgentSessionWireBuild, params: unknown): Promise<RpcReply[]> {
  const replies: RpcReply[] = []
  await build
    // Releases before the setting gate was dropped admit structured calls only with it on.
    .createDispatcher({
      getRuntimeId: () => 'runtime-1',
      getClientSettings: () => ({ experimentalStructuredNativeChat: true })
    })
    .dispatchStreaming(
      { id: 'request-send', authToken: 'cross-version-token', method: 'agentSession.send', params },
      (raw) => replies.push(JSON.parse(raw)),
      { clientKind: 'runtime', clientCapabilities: current.capabilities }
    )
  return replies
}

describe('a current client sending a message', () => {
  it.each([
    ['a plain message', undefined],
    // `delivery` joins the operation fingerprint, so a builder that drops it is refused by a host
    // that digests it.
    ['a message held as a draft while a turn runs', 'queue-if-active' as const]
  ])('is accepted for %s, under the fingerprint each build re-derives', async (_case, delivery) => {
    // Anti-vacuous: the release must have the method, or there is no older host to send to.
    expect(baseline.methodNames).toContain('agentSession.send')
    for (const build of [current, baseline]) {
      resetOperationIds()
      const hostCalls = structuredHostStub(SESSION, WORKSPACE)
      await build.installStructuredHost(installableHost(hostCalls))
      try {
        const replies = await send(build, sendParams('hi', 1, delivery))
        expect(replies, `${build.label}: ${JSON.stringify(replies)}`).toMatchObject([{ ok: true }])
        expect(hostCalls.send, `${build.label}: the send reached the host`).toHaveBeenCalledTimes(1)
        const sent: SentMessage = hostCalls.send.mock.calls[0]?.[1]
        expect(sent.delivery, `${build.label}: delivery reached the host`).toBe(delivery)
        // Past the fingerprint check, admission stops at the journal this harness never opens.
        expect(await build.admitSend(sent), `${build.label}: send admission`).toMatchObject({
          ok: false,
          refusal: { details: { reason: 'sessionNotAttached' } }
        })
        // Negative control: proves the fingerprint check ran before admission reached the journal.
        const wrong = { ...sent.envelope, payloadFingerprint: '0'.repeat(64) }
        expect(await build.admitSend({ ...sent, envelope: wrong }), build.label).toMatchObject({
          refusal: { details: { reason: 'fingerprintMismatch' } }
        })
      } finally {
        await build.installStructuredHost(null)
      }
    }
  })
})
