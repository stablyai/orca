// Cross-version coverage for the session-tab sync channel, paired the way the terminal and
// agent-session harnesses are: current code against a real published release.
//
// The wire-compatibility doc used to exclude this channel from the harness, and the exclusion
// was load-bearing: what a paired host puts in a worktree's tab list is decided per connection
// from the client's advertised capabilities, so the same host publishes different rows to two
// clients on the same socket. Nothing about that is visible from one build alone.
//
// Two client states matter and both are derived from the baseline release rather than written
// down here: C0, a client that never advertised structured chat, and C1, one that advertises the
// structured reader. Each is run against both an old host and a new one, because the channel is
// symmetric — the desktop is about to become a client of a host it also ships.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_READER_RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../src/shared/runtime-types'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import type { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { structuredHostStub, turnItemSkew } from './structured-agent-session-host-fixture'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcClientIdentity,
  type RpcReply
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const WORKTREE = 'wt-cross-version'
const TERMINAL_TAB = 'tab-1::leaf-1'
const CODEX_TAB = 'agent-session:session-codex'
const CLAUDE_TAB = 'agent-session:session-claude'
const CODEX_SESSION = 'session-codex'
const CLAUDE_SESSION = 'session-claude'
const CODEX_TAB_TITLE = 'Codex Chat'
const CLAUDE_TAB_TITLE = 'Claude Chat'
const LIST_METHOD = 'session.tabs.list'
const SUBSCRIBE_METHOD = 'session.tabs.subscribe'
const CLOSE_METHOD = 'session.tabs.close'
const HOLD_METHOD = 'agentSession.hold'

const PROJECTION_MODULE = '/src/main/runtime/rpc/methods/session-tab-agent-status-projection.ts'

/** The copy a host substitutes when a client cannot render the chat behind a row. Read per build,
 *  because it is the host's own string: a newer host may reword it, and that is not a break. */
type FallbackTabTitles = { update: string; desktopOnly: string }

/**
 * One worktree carrying durable work of three kinds: a terminal, a codex chat and a claude chat,
 * laid out across two groups so the focus and layout repair a withheld row forces is exercised
 * rather than assumed. The chat holds focus, so a client that cannot see it must be handed some
 * other active tab or it selects into nothing.
 */
function hostSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 7,
    activeGroupId: 'group-chat',
    activeTabId: CODEX_TAB,
    activeTabType: 'agent-session',
    tabGroups: [
      { id: 'group-terminal', activeTabId: TERMINAL_TAB, tabOrder: [TERMINAL_TAB] },
      {
        id: 'group-chat',
        activeTabId: CODEX_TAB,
        tabOrder: [CODEX_TAB, CLAUDE_TAB],
        recentTabIds: [CODEX_TAB, CLAUDE_TAB]
      }
    ],
    tabGroupLayout: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-terminal' },
      second: { type: 'leaf', groupId: 'group-chat' }
    },
    tabs: [
      {
        type: 'terminal',
        id: TERMINAL_TAB,
        parentTabId: 'tab-1',
        leafId: 'leaf-1',
        title: 'Terminal',
        status: 'ready',
        terminal: 'pty-1',
        isActive: false
      },
      {
        type: 'agent-session',
        id: CODEX_TAB,
        title: CODEX_TAB_TITLE,
        sessionId: CODEX_SESSION,
        agent: 'codex',
        isActive: true
      },
      {
        type: 'agent-session',
        id: CLAUDE_TAB,
        title: CLAUDE_TAB_TITLE,
        sessionId: CLAUDE_SESSION,
        agent: 'claude',
        isActive: false
      }
    ]
  }
}

type SessionTabsRuntimeStub = {
  runtime: unknown
  /** What the host itself holds. A projection is a per-connection view; if this ever changes,
   *  one client's capabilities have edited another client's durable work. */
  published: RuntimeMobileSessionTabsResult
  /** Push a host-side change to every live subscriber, as a real tab mutation does. */
  emitChange: (next: RuntimeMobileSessionTabsResult) => void
  closed: string[]
  restoreCalls: number
}

function sessionTabsRuntimeStub(): SessionTabsRuntimeStub {
  const listeners = new Set<(snapshot: RuntimeMobileSessionTabsResult) => void>()
  const cleanups = new Map<string, () => void>()
  const stub: SessionTabsRuntimeStub = {
    runtime: null,
    published: hostSnapshot(),
    emitChange: () => {},
    closed: [],
    restoreCalls: 0
  }
  stub.emitChange = (next) => {
    stub.published = next
    for (const listener of Array.from(listeners)) {
      listener(next)
    }
  }
  stub.runtime = {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    recordFeatureInteraction: () => {},
    restoreStructuredAgentSessionTabs: async () => {
      stub.restoreCalls += 1
    },
    listMobileSessionTabs: async () => stub.published,
    onMobileSessionTabsChanged: (listener: (snapshot: RuntimeMobileSessionTabsResult) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    closeMobileSessionTab: async (_worktree: string, tabId: string) => {
      stub.closed.push(tabId)
      return { closed: true }
    },
    refuseUnattributedMobileSessionTabClose: async (_worktree: string, tabId: string) => {
      stub.closed.push(tabId)
      return { refused: true, refusalReason: 'missing-intent' }
    },
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup),
    cleanupSubscription: (id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    },
    cleanupSubscriptionsByPrefix: (prefix: string) => {
      for (const [id, cleanup] of cleanups) {
        if (id.startsWith(prefix)) {
          cleanup()
          cleanups.delete(id)
        }
      }
    }
  }
  return stub
}

let baselineRef: string
let current: AgentSessionWireBuild
let baseline: AgentSessionWireBuild
let fallbackTitles: Map<string, FallbackTabTitles>

/** Read a build's own fallback copy from its own source, never from this file. */
async function loadFallbackTabTitles(ref: string): Promise<FallbackTabTitles> {
  const module =
    ref === WORKING_TREE
      ? ((await import('../../../src/main/runtime/rpc/methods/session-tab-agent-status-projection')) as unknown as Record<
          string,
          unknown
        >)
      : await importReleaseCheckoutModule(await materializeReleaseCheckout(ref), PROJECTION_MODULE)
  const update = module.STRUCTURED_CHAT_UPDATE_REQUIRED_TAB_TITLE
  const desktopOnly = module.CLAUDE_STRUCTURED_CHAT_DESKTOP_ONLY_TAB_TITLE
  if (typeof update !== 'string' || typeof desktopOnly !== 'string') {
    throw new Error(`Build ${ref} publishes no structured-chat fallback tab titles`)
  }
  return { update, desktopOnly }
}

beforeAll(async () => {
  baselineRef = resolveBaselineReleaseRef()
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  baseline = await loadAgentSessionWireBuild(baselineRef)
  fallbackTitles = new Map([
    [current.label, await loadFallbackTabTitles(WORKING_TREE)],
    [baseline.label, await loadFallbackTabTitles(baselineRef)]
  ])
}, SUITE_TIMEOUT_MS)

/** Every host build the channel has to work against, named for the failure message. */
function hostBuilds(): AgentSessionWireBuild[] {
  return [current, baseline]
}

/**
 * C0 — what a paired client too old to read structured chat advertises: the baseline's own list
 * minus the structured strings. Derived rather than copied, so the day a release ships the desktop
 * advertisement this list still describes a client that lacks it instead of quietly becoming C1.
 */
function c0(): string[] {
  return baseline.capabilities.filter(
    (capability) =>
      capability !== STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY &&
      capability !== CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  )
}

/** C1 — the reader advertisement itself, which admits codex rows and nothing else. */
function c1(): string[] {
  return [...c0(), STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

function c1WithClaudeReader(): string[] {
  return [...c1(), CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

/**
 * D — what a paired desktop of that build actually advertises, taken from the shipped constant
 * rather than assembled here. C0 and C1 above are hypotheses about clients; this one is the
 * client, so the day someone edits that list these journeys change with it instead of quietly
 * continuing to describe a desktop that no longer exists.
 */
function desktopOf(build: AgentSessionWireBuild): string[] {
  return [...build.clientCapabilities]
}

/** A desktop from before the advertisement, derived the way C0 is: once a release ships the reader
 *  strings, a hand-written list would stop being that client and start being this one. */
function withoutStructuredReader(capabilities: readonly string[]): string[] {
  const reader = new Set<string>(STRUCTURED_AGENT_SESSION_READER_RUNTIME_CAPABILITIES)
  return capabilities.filter((capability) => !reader.has(capability))
}

async function callBuild(
  build: AgentSessionWireBuild,
  method: string,
  params: unknown,
  client: RpcClientIdentity,
  runtime: unknown
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

function runtimeClient(clientCapabilities: readonly string[]): RpcClientIdentity {
  return { clientKind: 'runtime', clientCapabilities, connectionId: 'connection-1' }
}

function mobileClient(clientCapabilities: readonly string[]): RpcClientIdentity {
  return { clientKind: 'mobile', clientCapabilities, connectionId: 'connection-1' }
}

async function listTabs(
  build: AgentSessionWireBuild,
  stub: SessionTabsRuntimeStub,
  client: RpcClientIdentity
): Promise<RuntimeMobileSessionTabsResult> {
  const replies = await callBuild(build, LIST_METHOD, { worktree: WORKTREE }, client, stub.runtime)
  expect(replies, `${build.label}: ${LIST_METHOD} must answer exactly once`).toHaveLength(1)
  expect(replies[0], `${build.label}: ${LIST_METHOD} was refused`).toMatchObject({ ok: true })
  return replies[0]!.result as RuntimeMobileSessionTabsResult
}

/** Open a live subscription and keep collecting its frames as the host emits. */
async function subscribeTabs(
  build: AgentSessionWireBuild,
  stub: SessionTabsRuntimeStub,
  client: RpcClientIdentity
): Promise<RpcReply[]> {
  const replies = await callBuild(
    build,
    SUBSCRIBE_METHOD,
    { worktree: WORKTREE },
    client,
    stub.runtime
  )
  expect(replies, `${build.label}: ${SUBSCRIBE_METHOD} opened with no frame`).not.toHaveLength(0)
  return replies
}

function frameTabs(reply: RpcReply | undefined): RuntimeMobileSessionClientTab[] {
  return (reply?.result as RuntimeMobileSessionTabsResult | undefined)?.tabs ?? []
}

function tabIds(payload: { tabs: RuntimeMobileSessionClientTab[] }): string[] {
  return payload.tabs.map((tab) => tab.id)
}

function titlesFor(build: AgentSessionWireBuild): FallbackTabTitles {
  const titles = fallbackTitles.get(build.label)
  if (!titles) {
    throw new Error(`No fallback titles loaded for ${build.label}`)
  }
  return titles
}

describe('cross-version session-tab sync', () => {
  it(
    'skews current code against a real published release',
    () => {
      expect(baselineRef).toMatch(/^v?\d/)
      expect(baseline.revision).toMatch(/^[0-9a-f]{40}$/)
      expect(baseline.revision).not.toBe(current.revision)
      // Anti-vacuous: every claim below is about a method both builds really register, so a
      // registry that failed to load would fail here rather than pass as "withheld".
      for (const build of hostBuilds()) {
        for (const method of [LIST_METHOD, SUBSCRIBE_METHOD, CLOSE_METHOD]) {
          expect(build.methodNames, `${build.label} registers ${method}`).toContain(method)
        }
      }
      // The channel is additive: bumping the protocol number would strand every paired device
      // on this release rather than degrade one row.
      expect(current.protocolVersion).toBe(baseline.protocolVersion)
    },
    SUITE_TIMEOUT_MS
  )

  describe('a paired client that never advertised structured chat', () => {
    let stub: SessionTabsRuntimeStub

    beforeEach(() => {
      stub = sessionTabsRuntimeStub()
    })

    it('is served the worktree with its structured rows withheld, by either build', async () => {
      // Anti-vacuous: the old client still advertises a real list, so what follows is the
      // capability gate answering rather than an empty negotiation.
      expect(c0().length).toBeGreaterThan(0)
      expect(c0()).not.toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
      for (const build of hostBuilds()) {
        const projected = await listTabs(build, stub, runtimeClient(c0()))
        expect(tabIds(projected), `${build.label} withholds both chats`).toEqual([TERMINAL_TAB])
        // Focus followed the withheld row, so the repair is the difference between a usable
        // client and one selecting into a pane that renders neither chat nor terminal.
        expect(projected.activeTabId, `${build.label} repairs focus`).toBe(TERMINAL_TAB)
        expect(projected.activeTabType).toBe('terminal')
        expect(projected.activeGroupId).toBe('group-terminal')
        expect(projected.tabs[0]?.isActive).toBe(true)
        expect(projected.tabGroups?.map((group) => group.id)).toEqual(['group-terminal'])
        expect(projected.tabGroupLayout).toEqual({ type: 'leaf', groupId: 'group-terminal' })
      }
    })

    it('is withheld the rows without the host losing them', async () => {
      for (const build of hostBuilds()) {
        await listTabs(build, stub, runtimeClient(c0()))
      }
      // The one thing a projection must never do: a per-connection view is not a deletion, and a
      // client that cannot read a chat must not be why the host stops holding it.
      expect(stub.published).toEqual(hostSnapshot())
      const stillCapable = await listTabs(current, stub, runtimeClient(c1()))
      expect(tabIds(stillCapable)).toEqual([TERMINAL_TAB, CODEX_TAB])
    })

    it('cannot destroy a row it was never shown, on either build', async () => {
      for (const build of hostBuilds()) {
        const replies = await callBuild(
          build,
          CLOSE_METHOD,
          { worktree: WORKTREE, tabId: CODEX_TAB, reason: 'user' },
          runtimeClient(c0()),
          stub.runtime
        )
        expect(replies, `${build.label}: ${CLOSE_METHOD} must answer exactly once`).toHaveLength(1)
        // A refusal, not silence and not a close: the client has to be able to tell that its
        // view is narrower than the host's rather than retry a vanished tab forever.
        expect(replies[0], `${build.label} refuses the unseen close`).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('tab_not_found') }
        })
      }
      expect(stub.closed).toEqual([])
      expect(stub.published).toEqual(hostSnapshot())
    })

    it('keeps its live subscription projected on updates, not only on the opening frame', async () => {
      for (const build of hostBuilds()) {
        const frames = await subscribeTabs(build, stub, runtimeClient(c0()))
        expect(frameTabs(frames[0]).map((tab) => tab.id)).toEqual([TERMINAL_TAB])
        const renamed = hostSnapshot()
        renamed.tabs[1] = { ...renamed.tabs[1]!, title: 'Codex Chat (renamed)' }
        stub.emitChange(renamed)
        // A projection applied only to the opening snapshot leaks the row on the very next
        // title tick, and the leak is invisible to any test that only opens a subscription.
        expect(frames, `${build.label} pushed no update`).toHaveLength(2)
        expect(frames[1]?.result).toMatchObject({ type: 'updated' })
        expect(frameTabs(frames[1]).map((tab) => tab.id)).toEqual([TERMINAL_TAB])
        stub.emitChange(hostSnapshot())
      }
    })
  })

  describe('a paired client advertising the structured reader', () => {
    let stub: SessionTabsRuntimeStub

    beforeEach(() => {
      stub = sessionTabsRuntimeStub()
    })

    it('is published the codex row verbatim by either build', async () => {
      for (const build of hostBuilds()) {
        const projected = await listTabs(build, stub, runtimeClient(c1()))
        expect(tabIds(projected), `${build.label} publishes the codex chat`).toEqual([
          TERMINAL_TAB,
          CODEX_TAB
        ])
        const codex = projected.tabs.find((tab) => tab.id === CODEX_TAB)
        // Verbatim, not merely present: a reader that is handed a substituted title has been
        // told to update while being given the thing it can read.
        expect(codex, `${build.label} publishes the codex row unchanged`).toMatchObject({
          type: 'agent-session',
          title: CODEX_TAB_TITLE,
          sessionId: CODEX_SESSION,
          agent: 'codex'
        })
        expect(projected.activeTabId).toBe(CODEX_TAB)
        expect(projected.activeTabType).toBe('agent-session')
      }
    })

    it('still receives no claude row until it says it can read one', async () => {
      for (const build of hostBuilds()) {
        const projected = await listTabs(build, stub, runtimeClient(c1()))
        expect(tabIds(projected), `${build.label} withholds the claude chat`).not.toContain(
          CLAUDE_TAB
        )
        const both = await listTabs(build, stub, runtimeClient(c1WithClaudeReader()))
        expect(tabIds(both), `${build.label} publishes both chats`).toEqual([
          TERMINAL_TAB,
          CODEX_TAB,
          CLAUDE_TAB
        ])
        expect(both.tabs.find((tab) => tab.id === CLAUDE_TAB)).toMatchObject({
          title: CLAUDE_TAB_TITLE,
          sessionId: CLAUDE_SESSION
        })
      }
      expect(stub.published).toEqual(hostSnapshot())
    })

    it('finds a session the host already had, with nothing republished for it', async () => {
      for (const build of hostBuilds()) {
        const beforeAdvertisement = await listTabs(build, stub, runtimeClient(c0()))
        expect(tabIds(beforeAdvertisement)).toEqual([TERMINAL_TAB])
        const afterAdvertisement = await listTabs(build, stub, runtimeClient(c1()))
        // The advertisement is the only thing that moved: same host, same record, same
        // publication epoch — so a client turning the reader on resumes into work that was
        // already there rather than waiting for the next host-side change to surface it.
        expect(tabIds(afterAdvertisement)).toEqual([TERMINAL_TAB, CODEX_TAB])
        expect(afterAdvertisement.publicationEpoch).toBe(beforeAdvertisement.publicationEpoch)
        expect(afterAdvertisement.snapshotVersion).toBe(beforeAdvertisement.snapshotVersion)
      }
      expect(stub.restoreCalls).toBeGreaterThan(0)
      expect(stub.published).toEqual(hostSnapshot())
    })
  })

  describe('a mobile client that cannot render the chat behind the row', () => {
    let stub: SessionTabsRuntimeStub

    beforeEach(() => {
      stub = sessionTabsRuntimeStub()
    })

    it('keeps a metadata-only row under the fallback title its own build publishes', async () => {
      for (const build of hostBuilds()) {
        const titles = titlesFor(build)
        const projected = await listTabs(build, stub, mobileClient(c0()))
        // Nothing removed: the phone user was hunting for a chat the desktop insisted existed.
        expect(tabIds(projected), `${build.label} keeps every row for mobile`).toEqual([
          TERMINAL_TAB,
          CODEX_TAB,
          CLAUDE_TAB
        ])
        expect(projected.tabs.find((tab) => tab.id === CODEX_TAB)).toMatchObject({
          title: titles.update,
          sessionId: CODEX_SESSION,
          agent: 'codex'
        })
        expect(projected.tabs.find((tab) => tab.id === CLAUDE_TAB)).toMatchObject({
          title: titles.desktopOnly,
          sessionId: CLAUDE_SESSION,
          agent: 'claude'
        })
        // Withheld content, not a corrupted row: the substitution replaces copy and nothing else.
        expect(projected.activeTabId).toBe(CODEX_TAB)
        expect(titles.update).not.toBe(CODEX_TAB_TITLE)
        expect(titles.desktopOnly).not.toBe(CLAUDE_TAB_TITLE)
      }
    })

    it('is refused when it tries to close a row it can see but not read', async () => {
      for (const build of hostBuilds()) {
        const replies = await callBuild(
          build,
          CLOSE_METHOD,
          { worktree: WORKTREE, tabId: CODEX_TAB, reason: 'user' },
          mobileClient(c0()),
          stub.runtime
        )
        expect(replies, `${build.label}: ${CLOSE_METHOD} must answer exactly once`).toHaveLength(1)
        expect(replies[0], `${build.label} refuses the mobile close`).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining('structured_agent_session_unsupported') }
        })
      }
      // The row is visible to this client, so only the destructive gate stands between a
      // fallback title and a client closing durable work it was never able to open.
      expect(stub.closed).toEqual([])
      expect(stub.published).toEqual(hostSnapshot())
    })
  })

  describe('the turn item rides the same projection', () => {
    let stub: SessionTabsRuntimeStub

    beforeEach(() => {
      stub = sessionTabsRuntimeStub()
      turnItemSkew.install(CODEX_SESSION, WORKTREE)
    })

    afterEach(() => {
      setStructuredAgentSessionHost(null)
    })

    it('publishes the row to a reader that predates the turn item, and downgrades the item', async () => {
      for (const [clientCapabilities, item] of turnItemSkew.clients(baseline, current)) {
        const client = runtimeClient(clientCapabilities)
        const projected = await listTabs(current, stub, client)
        expect(tabIds(projected)).toContain(CODEX_TAB)
        const replies = await callBuild(
          current,
          'agentSession.history',
          { sessionId: CODEX_SESSION, direction: 'tail' },
          client,
          stub.runtime
        )
        // Two independent gates on one connection: advertising that you can read the row says
        // nothing about the item bodies inside it, and a host that collapsed them would publish
        // an unknown kind to a client whose tab it had just decided to show.
        expect(replies[0]).toMatchObject({ ok: true, result: { page: { items: [item] } } })
      }
    })
  })

  /**
   * The desktop this release ships is the client PR-12 was written against in the abstract. These
   * journeys use its real advertisement, so the harness stops describing a hypothesis and starts
   * describing the build.
   */
  describe('the paired desktop this release ships', () => {
    let stub: SessionTabsRuntimeStub

    beforeEach(() => {
      stub = sessionTabsRuntimeStub()
    })

    afterEach(() => {
      setStructuredAgentSessionHost(null)
    })

    it('advertises the reader and nothing whose surface it cannot yet drive', () => {
      const desktop = desktopOf(current)
      // Anti-vacuous: a list read from the wrong export, or an empty one, would satisfy every
      // absence below while proving nothing about what this desktop says on the wire.
      expect(desktop.length).toBeGreaterThan(0)
      for (const capability of STRUCTURED_AGENT_SESSION_READER_RUNTIME_CAPABILITIES) {
        expect(desktop, `the desktop advertises ${capability}`).toContain(capability)
      }
      for (const adjunct of [
        STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
      ]) {
        // This build names all three, so leaving them out is a decision about what the renderer
        // can answer for rather than a string nobody has written down yet.
        expect(current.capabilities, `${adjunct} exists in this build`).toContain(adjunct)
        expect(desktop, `the desktop withholds ${adjunct}`).not.toContain(adjunct)
      }
    })

    it('is published the structured rows by either host while an older desktop still is not', async () => {
      const olderDesktop = withoutStructuredReader(desktopOf(baseline))
      expect(olderDesktop.length).toBeGreaterThan(0)
      for (const build of hostBuilds()) {
        const projected = await listTabs(build, stub, runtimeClient(desktopOf(current)))
        expect(tabIds(projected), `${build.label} publishes both chats to this desktop`).toEqual([
          TERMINAL_TAB,
          CODEX_TAB,
          CLAUDE_TAB
        ])
        expect(projected.tabs.find((tab) => tab.id === CLAUDE_TAB)).toMatchObject({
          title: CLAUDE_TAB_TITLE,
          sessionId: CLAUDE_SESSION
        })
        // Same host, same socket, a client that predates the advertisement: the decision is per
        // connection, so shipping it here does not change what an older desktop is handed.
        const older = await listTabs(build, stub, runtimeClient(olderDesktop))
        expect(tabIds(older), `${build.label} still withholds from an older desktop`).toEqual([
          TERMINAL_TAB
        ])
      }
      expect(stub.published).toEqual(hostSnapshot())
    })

    it('finds a session the host already had, at the publication it was already at', async () => {
      for (const build of hostBuilds()) {
        const projected = await listTabs(build, stub, runtimeClient(desktopOf(current)))
        expect(tabIds(projected)).toContain(CODEX_TAB)
        // The advertisement restores the host's own records; it does not mint a publication, so a
        // desktop that turns it on lands on the work that was already there.
        expect(projected.publicationEpoch).toBe(hostSnapshot().publicationEpoch)
        expect(projected.snapshotVersion).toBe(hostSnapshot().snapshotVersion)
      }
      expect(stub.restoreCalls).toBeGreaterThan(0)
      expect(stub.published).toEqual(hostSnapshot())
    })

    it('would be let through to a hold, so only this client keeps it from waking a provider', async () => {
      const host = structuredHostStub(CODEX_SESSION, WORKTREE)
      setStructuredAgentSessionHost(host as unknown as StructuredAgentSessionHost)
      const held = await callBuild(
        current,
        HOLD_METHOD,
        { sessionId: CODEX_SESSION, holderId: 'desktop-chat' },
        runtimeClient(desktopOf(current)),
        stub.runtime
      )
      // The reader advertisement admits the whole read surface AND the hold: the host gates the
      // hold on the reader string, not on the hold string this desktop withholds. So nothing on
      // the host side is what stops a read-only pane opening a record and handing its session a
      // provider child back — the renderer is, and its guard is the only one there is.
      expect(held[0], 'the host admits a hold from this desktop').toMatchObject({ ok: true })
      expect(host.hold).toHaveBeenCalledTimes(1)
      host.hold.mockClear()
      const refused = await callBuild(
        current,
        HOLD_METHOD,
        { sessionId: CODEX_SESSION, holderId: 'desktop-chat' },
        runtimeClient(withoutStructuredReader(desktopOf(baseline))),
        stub.runtime
      )
      expect(refused[0], 'a desktop without the advertisement is refused').toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('structured_agent_session_unsupported') }
      })
      expect(host.hold).not.toHaveBeenCalled()
    })
  })
})
