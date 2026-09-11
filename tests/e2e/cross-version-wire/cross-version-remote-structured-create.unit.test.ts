// A new client aiming a structured create at a host on a different release.
//
// PR-14 is the first release where a user can start a chat on another machine, and the peer on the
// other end updates on its own schedule — mixed versions are the normal state. The failure that
// matters is not the refusal itself but a HALF create: a client that records a focus intent, asks
// an older host, gets a token it cannot classify, and leaves a tab waiting for a session nobody
// made — or worse, opens a second session beside one the host may already hold.
//
// The old side's answers are taken from a real published release rather than written here, so
// every "this is what an older host says" claim is a fact about a build. The client half is the
// real launch path: the verdict lives there, and mocking it would assert nothing.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { resolveBaselineReleaseRef } from './release-checkout'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply
} from './versioned-agent-session-wire'

const SUITE_TIMEOUT_MS = 180_000
const WORKTREE_ID = 'repo-1::/repo/wt-1'
const ENVIRONMENT_ID = 'env-1'
const PAIRING_REVISION = 7
const CREATE_SUPPORT_METHOD = 'agentSession.createSupport'
const CREATE_METHOD = 'agentSession.create'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: `runtime:${ENVIRONMENT_ID}`,
      unifiedTabsByWorktree: {},
      groupsByWorktree: {}
    }),
    subscribe: () => () => undefined
  }
}))

import {
  createStructuredAgentSessionLaunchIntent,
  isDefinitiveStructuredAgentSessionCreateError,
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from '@/lib/launch-structured-agent-session'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  structuredAgentSessionOwnerIntentKey,
  type StructuredAgentSessionOwner
} from '@/runtime/structured-agent-session-owner'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'

let baseline: AgentSessionWireBuild
let current: AgentSessionWireBuild

/** Only what the old dispatcher reads to stamp a reply; nothing here answers a method. */
function runtimeStub(): unknown {
  return { getRuntimeId: () => 'runtime-old' }
}

/** What the old release's own dispatcher really answers, asked the way this client asks. */
async function baselineReply(
  method: string,
  params: unknown,
  clientCapabilities: readonly string[]
): Promise<RpcReply> {
  const replies: RpcReply[] = []
  await baseline
    .createDispatcher(runtimeStub())
    .dispatchStreaming(
      { id: `request-${method}`, authToken: 'cross-version-token', method, params },
      (raw) => replies.push(JSON.parse(raw) as RpcReply),
      { clientKind: 'runtime', clientCapabilities }
    )
  // Silence is the one answer a client cannot recover from, so it is pinned before any code is.
  expect(replies, `${method} must answer exactly once`).toHaveLength(1)
  return replies[0] as RpcReply
}

/** The old host's reply as the renderer transport hands it to the launch path. */
function asTransportError(reply: RpcReply): RuntimeRpcCallError {
  expect(reply.ok, `expected a refusal, got ${JSON.stringify(reply)}`).toBe(false)
  return new RuntimeRpcCallError({ ok: false, error: reply.error } as never)
}

/** What a client too old to know the structured surface advertises — derived, because the day a
 *  release ships the capability an as-is copy of the list would stop exercising the gate. */
function withoutStructuredReader(): string[] {
  return baseline.clientCapabilities.filter(
    (capability) => !capability.startsWith('agent-session.')
  )
}

function createSupportParams(): unknown {
  return { worktree: `id:${WORKTREE_ID}`, agent: 'codex' }
}

function focusIntentFor(owner: StructuredAgentSessionOwner) {
  return peekWebSessionFocusIntent(structuredAgentSessionOwnerIntentKey(owner), WORKTREE_ID)
}

function callsTo(method: string): unknown[][] {
  return mocks.call.mock.calls.filter((call) => call[1] === method)
}

beforeAll(async () => {
  ;[current, baseline] = await Promise.all([
    loadAgentSessionWireBuild(WORKING_TREE),
    loadAgentSessionWireBuild(await resolveBaselineReleaseRef())
  ])
}, SUITE_TIMEOUT_MS)

beforeEach(() => {
  vi.clearAllMocks()
  resetWebSessionFocusIntentForTests()
  replaceRuntimeEnvironmentRevisions([
    { id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: PAIRING_REVISION }
  ])
})

describe('a remote structured create against an older host', () => {
  it('skews current code against a real published release', () => {
    expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(baseline.revision).not.toBe(current.revision)
    // Anti-vacuous: the scan really read the old build's registry.
    expect(baseline.methodNames).toContain('terminal.create')
    // The shape of this skew, derived rather than assumed: the released host already HAS the
    // create surface. What it does not have is a client it will run it for — so the answer a
    // PR-14 client meets here is a refusal, not an absent method.
    expect(baseline.methodNames).toContain(CREATE_METHOD)
    expect(withoutStructuredReader().length).toBeGreaterThan(0)
  })

  it('refuses a client it does not publish structured chat to, with a token not a silence', async () => {
    const reply = await baselineReply(
      CREATE_SUPPORT_METHOD,
      createSupportParams(),
      withoutStructuredReader()
    )

    expect(reply).toMatchObject({ ok: false })
    // Definitive is the whole point: it is what licenses opening a terminal chat instead, because
    // the host proved it made nothing. A code outside this set would have to replay instead.
    expect(isDefinitiveStructuredAgentSessionCreateError(asTransportError(reply))).toBe(true)
  })

  it('fails closed before it asks that host to create anything', async () => {
    const refusal = asTransportError(
      await baselineReply(CREATE_SUPPORT_METHOD, createSupportParams(), withoutStructuredReader())
    )
    mocks.call.mockRejectedValue(refusal)
    const intent = createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex')
    expect(intent.owner).toMatchObject({ kind: 'environment', environmentId: ENVIRONMENT_ID })
    expect(focusIntentFor(intent.owner)).toBeTruthy()

    const error = await launchStructuredAgentSession(intent).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    // The whole meaning of "before side effects": the probe is the only thing that ran.
    expect(callsTo(CREATE_METHOD), 'a create reached a host that refuses them').toHaveLength(0)
    expect(callsTo(CREATE_SUPPORT_METHOD)).toHaveLength(1)
    // ...and no tab is left waiting for a session nobody made.
    expect(focusIntentFor(intent.owner)).toBeFalsy()
  })

  it('reads a host older than the method itself the same way', async () => {
    // The answer shape from a host that predates a method, produced by the released dispatcher
    // rather than written here, so it stays the real one if the envelope ever changes.
    const reply = await baselineReply(
      'agentSession.methodThisReleaseNeverShipped',
      {},
      current.clientCapabilities
    )
    expect(reply).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    mocks.call.mockRejectedValue(asTransportError(reply))
    const intent = createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex')

    const error = await launchStructuredAgentSession(intent).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateRefusalError)
    expect(isDefinitiveStructuredAgentSessionCreateError(error)).toBe(true)
    expect(callsTo(CREATE_METHOD)).toHaveLength(0)
    expect(focusIntentFor(intent.owner)).toBeFalsy()
  })

  it('never opens a sibling when the outcome is merely unknown', async () => {
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === CREATE_SUPPORT_METHOD
        ? { supported: true }
        : { ok: false, refusal: { code: 'agent_session_busy', message: 'still settling' } }
    )
    const intent = createStructuredAgentSessionLaunchIntent(WORKTREE_ID, 'codex')

    const error = await launchStructuredAgentSession(intent).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(StructuredAgentSessionCreateUnknownOutcomeError)
    expect(isDefinitiveStructuredAgentSessionCreateError(error)).toBe(false)
    // Kept on purpose: the session may exist on the peer, and recovery still has to adopt it.
    expect(focusIntentFor(intent.owner)).toBeTruthy()
  })
})
