// Mixed-version coverage for the structured attention stream, with real frames on it.
//
// `agentSession.subscribeTurnCompletions` now also carries a `prompt` arm, sent only to a subscriber
// that opted in with `includePrompts`, and a new `agentSession.acknowledgeAttention` method retires
// what a host pushed its phones. Each pairing below runs one build's real RPC method over that same
// build's real attention feed, and drives a turn that asks for approval mid-turn and then settles:
//
// - current client, current host: the prompt arrives as its own frame, once;
// - older client (no opt-in), current host: only frames an older reader knows ever arrive;
// - current client, baseline host: the opt-in is ignored rather than refused, completions still come,
//   and the acknowledgement method is absent exactly when its capability is.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionTurnCompletionFeed } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import { RuntimeSubscriptionRegistry } from '../../../src/main/runtime/runtime-subscription-registry'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatusState } from '../../../src/shared/structured-agent-session-projection'
import {
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import { installableHost, structuredHostStub } from './structured-agent-session-host-fixture'
import { SESSION, WORKSPACE } from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply
} from './versioned-agent-session-wire'

const SUITE_TIMEOUT_MS = 180_000
const FEED_PATH =
  'src/main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed.ts'
const PROJECTION_PATH = 'src/shared/structured-agent-session-projection.ts'
const ACK_METHOD = 'agentSession.acknowledgeAttention'

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKSPACE,
  workspaceKind: 'git-worktree'
} as const

/** One build's own feed class and projection: the host half of the pairing. */
type FeedBuild = {
  StructuredAgentSessionTurnCompletionFeed: new (deps: unknown) => {
    subscribe: (subscriber: unknown) => () => void
    observe: (sessionId: string) => void
  }
  projectStructuredAgentSessionStatusState: (
    items: AgentJournalRenderItem[],
    submissions: unknown[]
  ) => unknown
}

let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild
let currentFeed: FeedBuild
let baselineFeed: FeedBuild

async function loadFeedBuild(
  load: (path: string) => Promise<Record<string, unknown>>
): Promise<FeedBuild> {
  const [feed, projection] = await Promise.all([load(FEED_PATH), load(PROJECTION_PATH)])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each build exports both members by these names; a missing one fails the first pairing.
  return { ...feed, ...projection } as unknown as FeedBuild
}

beforeAll(async () => {
  const ref = resolveBaselineReleaseRef()
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(ref)
  const checkout = await materializeReleaseCheckout(ref)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: current source's own exports, typed loosely to match the release build's.
  currentFeed = {
    StructuredAgentSessionTurnCompletionFeed,
    projectStructuredAgentSessionStatusState
  } as unknown as FeedBuild
  baselineFeed = await loadFeedBuild((path) => importReleaseCheckoutModule(checkout, path))
}, SUITE_TIMEOUT_MS)

const USER: AgentJournalRenderItem = {
  itemId: 'user-1',
  revision: 0,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'migrate' }] }
}

function turnRow(state: 'running' | 'completed'): AgentJournalRenderItem {
  return {
    itemId: 'codex:turn:turn-1',
    revision: state === 'running' ? 1 : 2,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: 'turn-1',
      state,
      ...(state === 'completed' ? { outcome: 'success' } : {})
    }
  }
}

function approval(state: 'pending' | 'resolved'): AgentJournalRenderItem {
  return {
    itemId: 'approval-1',
    revision: state === 'pending' ? 1 : 2,
    sequence: 3,
    observedAt: 3,
    body: {
      kind: 'approval',
      title: 'Run migration?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state, selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
}

/** The journal states a turn passes through: running, asking mid-turn, answered, settled. */
const JOURNEY: AgentJournalRenderItem[][] = [
  [USER, turnRow('running')],
  [USER, turnRow('running'), approval('pending')],
  [USER, turnRow('running'), approval('resolved')],
  [USER, turnRow('completed'), approval('resolved')]
]

/** Runs the journey through `host`'s feed behind `rpc`'s dispatcher, and returns every frame the
 *  subscriber that sent `params` received. */
async function framesFor(
  rpc: AgentSessionWireBuild,
  host: FeedBuild,
  params: unknown
): Promise<unknown[]> {
  let items: AgentJournalRenderItem[] = []
  let sequence = 0
  const sessions = new Map([
    [
      SESSION,
      {
        journal: { cursor: () => ({ epoch: 'epoch-1', sequence }) },
        params: { location: LOCATION }
      }
    ]
  ])
  const feed = new host.StructuredAgentSessionTurnCompletionFeed({
    sessions,
    now: () => 10,
    readStatusState: () => host.projectStructuredAgentSessionStatusState(items, [])
  })
  const hostCalls = structuredHostStub(SESSION, WORKSPACE)
  hostCalls.subscribeTurnCompletions = vi.fn((subscriber: unknown) => feed.subscribe(subscriber))
  await rpc.installStructuredHost(installableHost(hostCalls))
  const replies: RpcReply[] = []
  await rpc.createDispatcher(runtimeStub()).dispatchStreaming(
    {
      id: 'attention',
      authToken: 'cross-version-token',
      method: 'agentSession.subscribeTurnCompletions',
      params
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every frame the dispatcher writes is a serialized RpcReply; a drifted shape fails the assertions below.
    (raw) => replies.push(JSON.parse(raw) as RpcReply),
    { clientKind: 'runtime', clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
  )
  expect(
    replies.filter((reply) => !reply.ok),
    `${rpc.label}: subscription refused ${JSON.stringify(replies)}`
  ).toEqual([])
  for (const next of JOURNEY) {
    items = next
    sequence += 1
    feed.observe(SESSION)
  }
  return replies.map((reply) => reply.result)
}

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

const frameTypes = (frames: unknown[]): unknown[] =>
  frames.map((frame) =>
    frame && typeof frame === 'object' && 'type' in frame ? frame.type : frame
  )

describe('structured attention frames across versions', () => {
  it('current client, current host: the mid-turn prompt is its own frame, then the settle', async () => {
    const frames = await framesFor(current, currentFeed, { includePrompts: true })
    expect(frameTypes(frames)).toEqual(['prompt', 'completion'])
    expect(frames[0]).toMatchObject({ prompt: { sessionId: SESSION, promptId: 'approval-1' } })
  })

  it('older client against the current host: only the frames an older reader already knows', async () => {
    // A client that predates the opt-in sends none; the arm it could not read must never reach it.
    const frames = await framesFor(current, currentFeed, {})
    expect(frameTypes(frames)).toEqual(['completion'])
  })

  it('current client against the baseline host: the opt-in is ignored, not refused', async () => {
    const frames = await framesFor(baseline, baselineFeed, { includePrompts: true })
    // Whatever the baseline host sends, the settle still arrives and nothing it sends is refused.
    expect(frameTypes(frames)).toContain('completion')
    for (const frame of frames) {
      expect(['completion', 'prompt']).toContain(frameTypes([frame])[0])
    }
  })

  it('the acknowledgement method exists exactly where its capability is advertised', () => {
    for (const build of [current, baseline]) {
      expect(build.methodNames.includes(ACK_METHOD), build.label).toBe(
        build.capabilities.includes(AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY)
      )
    }
    expect(current.capabilities).toContain(AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY)
  })
})
