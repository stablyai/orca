// A structured agent beyond Claude and Codex, paired across two builds: current code against the
// newest published release.
//
// A host now accepts any agent it registered, publishes those agents, and stores their records.
// Clients and hosts update independently, so each skew must hold before such an agent ships:
//
//  - an old client paired with a new host never meets that agent's tab, and the Claude and Codex
//    tabs it does meet are what its own build would have published;
//  - an old build reading what a new one stored (a tab, a record) keeps every other tab and never
//    mistakes the new agent's record for another provider;
//  - a new client against an old host does not offer the agent, because the capability is absent.
//
// The old side's lists are read from its checkout and the capability removed from them, so this
// stays exercised after a release ships the capability (docs/reference/remote-wire-compatibility.md).
// What the old side stores is its own code, so those expectations follow what the baseline host
// advertises, never its version.

import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../src/main/ipc/desktop-renderer-runtime-capabilities'
import { projectSessionTabAgentStatus } from '../../../src/main/runtime/rpc/methods/session-tab-agent-status-projection'
import { agentSessionRecordFixture } from '../../../src/shared/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../../src/shared/agent-session-record-stored-form'
import {
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../../src/shared/agent-session-record'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'
import {
  RUNTIME_CAPABILITIES,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../src/shared/runtime-types'
import { resolveStructuredNativeChatSupport } from '../../../src/shared/structured-native-chat-launch-route'
import { STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { parseWorkspaceSession } from '../../../src/shared/workspace-session-schema'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

const NEW_AGENT = 'grok'
const WORKTREE = 'wt-1'

type Baseline = {
  ref: string
  wire: AgentSessionWireBuild
  desktopClientCapabilities: readonly string[]
  /** Releases before the host admitted by client capability alone also took the host's chat
   *  setting; passing it on is harmless to one that no longer reads it. */
  projectSessionTabAgentStatus: (
    payload: RuntimeMobileSessionTabsSnapshot,
    clientKind: 'mobile' | 'runtime',
    clientCapabilities: readonly string[],
    structuredNativeChatEnabled: boolean
  ) => RuntimeMobileSessionTabsSnapshot
  parseWorkspaceSession: (raw: unknown) => { ok: boolean; value?: unknown }
  isStructuredTab: (tab: unknown) => boolean
  /** The optional list supports releases that gated stored reads on registration. */
  isPersistedAgentSessionRecord: (value: unknown, agents?: unknown) => boolean
}

let baseline: Baseline
let current: AgentSessionWireBuild

function member<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the baseline release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a release module is typed unknown; the name is the same export this build calls, and a missing one throws above.
  return value as T
}

beforeAll(async () => {
  const ref = resolveBaselineReleaseRef()
  const checkout = await materializeReleaseCheckout(ref)
  const [capabilities, projection, schema, tabs, record] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/ipc/desktop-renderer-runtime-capabilities.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/rpc/methods/session-tab-agent-status-projection.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/shared/workspace-session-schema.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/structured-agent-session-tabs.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-record.ts')
  ])
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  const wire = await loadAgentSessionWireBuild(ref)
  baseline = {
    ref,
    wire,
    desktopClientCapabilities: member(capabilities, 'DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES'),
    projectSessionTabAgentStatus: member(projection, 'projectSessionTabAgentStatus'),
    parseWorkspaceSession: member(schema, 'parseWorkspaceSession'),
    isStructuredTab: member(tabs, 'isStructuredTab'),
    isPersistedAgentSessionRecord: member(record, 'isPersistedAgentSessionRecord')
  }
}, SUITE_TIMEOUT_MS)

/** Whether a build's saved tabs support open agent ids. */
function registersAgents(build: AgentSessionWireBuild): boolean {
  return build.capabilities.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY)
}

function baselineReadsRecord(record: AgentSessionRecord): boolean {
  return baseline.isPersistedAgentSessionRecord(
    encodeAgentSessionRecord(record),
    new Set(['claude', 'codex'])
  )
}

/** What a desktop too old to render the host's agents advertises: its own list without the
 *  capability, so the day a release ships it this still describes a client that predates it. */
function oldDesktopClientCapabilities(): string[] {
  return baseline.desktopClientCapabilities.filter(
    (capability) => capability !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}

/** What a host too old to register agents advertises, derived the same way. */
function oldHostCapabilities(): string[] {
  return baseline.wire.capabilities.filter(
    (capability) => capability !== STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  )
}

function chatTab(agent: string, isActive: boolean) {
  return {
    type: 'agent-session' as const,
    id: `agent-session:${agent}-session-1`,
    title: `${agent} chat`,
    sessionId: `${agent}-session-1`,
    agent,
    isActive
  }
}

function tabsSnapshot(agents: readonly string[]): RuntimeMobileSessionTabsSnapshot {
  const tabs = agents.map((agent, index) => chatTab(agent, index === 0))
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: tabs[0]?.id ?? null,
    activeTabType: 'agent-session',
    tabGroups: [
      {
        id: 'group-1',
        activeTabId: tabs[0]?.id ?? null,
        tabOrder: tabs.map((tab) => tab.id)
      }
    ],
    tabs
  }
}

function persistedChatTab(id: string, agentSessionAgent: string) {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent,
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

/** A workspace session as this build persists it with chats of three agents open. */
function persistedSession(): unknown {
  return {
    activeRepoId: null,
    activeWorktreeId: WORKTREE,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: {
      [WORKTREE]: [
        persistedChatTab('chat-claude', 'claude'),
        persistedChatTab('chat-new-agent', NEW_AGENT),
        persistedChatTab('chat-codex', 'codex')
      ]
    },
    activeTabTypeByWorktree: { [WORKTREE]: 'agent-session' }
  }
}

function newAgentRecord(): AgentSessionRecord {
  const record = agentSessionRecordFixture()
  return {
    ...record,
    provider: NEW_AGENT,
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: { transport: 'acp', agent: NEW_AGENT, nativeId: 'native-session-1' }
    })),
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok' }
  }
}

/** A parsed session's chat tabs in the test worktree, read through a named shape. */
const parsedSessionTabs = z.object({
  unifiedTabs: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
})

function unifiedTabsOf(parsed: { ok: boolean; value?: unknown }): Record<string, unknown>[] {
  const session = parsedSessionTabs.safeParse(parsed.value)
  return session.success ? (session.data.unifiedTabs[WORKTREE] ?? []) : []
}

describe('a structured agent beyond Claude and Codex, across versions', () => {
  it(
    'pairs current code with a real published release',
    () => {
      expect(baseline.ref).toMatch(/^v?\d/)
      // Anti-vacuous: the old desktop still says it reads structured chats, so a withheld tab
      // below is this capability's gate answering, not the whole surface being refused.
      expect(oldDesktopClientCapabilities()).toContain(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
    },
    SUITE_TIMEOUT_MS
  )

  describe('old client, new host', () => {
    it("never receives the new agent's tab, and its Claude and Codex tabs are what its own build publishes", () => {
      const client = oldDesktopClientCapabilities()
      const projected = projectSessionTabAgentStatus(
        tabsSnapshot([NEW_AGENT, 'claude', 'codex']),
        'runtime',
        client
      )
      expect(projected.tabs.map((tab) => tab.id)).not.toContain(chatTab(NEW_AGENT, false).id)
      expect(projected.tabGroups?.[0]?.tabOrder).not.toContain(chatTab(NEW_AGENT, false).id)
      // Same-version reference: the release publishing the same chats to its own client.
      const reference = baseline.projectSessionTabAgentStatus(
        tabsSnapshot(['claude', 'codex']),
        'runtime',
        client,
        true
      )
      expect(reference.tabs.length).toBe(2)
      expect(projected.tabs).toEqual(reference.tabs)
    })

    it('keeps every other tab when it loads a session a newer build saved', () => {
      const parsed = baseline.parseWorkspaceSession(persistedSession())
      expect(parsed.ok).toBe(true)
      const tabs = unifiedTabsOf(parsed)
      expect(tabs.map((tab) => tab.id)).toEqual(['chat-claude', 'chat-new-agent', 'chat-codex'])
      if (registersAgents(baseline.wire)) {
        // It already keeps any agent's id; whether it mounts that chat is its own client's call.
        expect(tabs.map((tab) => tab.agentSessionAgent)).toEqual(['claude', NEW_AGENT, 'codex'])
        expect([tabs[0], tabs[2]].map((tab) => baseline.isStructuredTab(tab))).toEqual([true, true])
      } else {
        expect(tabs.map((tab) => tab.agentSessionAgent)).toEqual(['claude', undefined, 'codex'])
        // The tab it cannot place stays listed and mounts no chat pane.
        expect(tabs.map((tab) => baseline.isStructuredTab(tab))).toEqual([true, false, true])
      }
      // This build reads the same saved session with the agent intact.
      expect(
        unifiedTabsOf(parseWorkspaceSession(persistedSession())).map((tab) => tab.agentSessionAgent)
      ).toEqual(['claude', NEW_AGENT, 'codex'])
    })

    it('classifies a saved new-agent record and keeps Claude and Codex records readable', () => {
      // Older admission gates may refuse it; provider-independent releases can read it.
      expect(baselineReadsRecord(newAgentRecord())).toBeTypeOf('boolean')
      expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(newAgentRecord()))).toBe(true)
      const claude = agentSessionRecordFixture()
      const codex: AgentSessionRecord = {
        ...claude,
        provider: 'codex',
        providerHandleChain: claude.providerHandleChain.map((link) => ({
          ...link,
          handle: codexProviderHandle('thread-1')
        })),
        accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' }
      }
      for (const record of [claude, codex]) {
        expect(baselineReadsRecord(record)).toBe(true)
      }
    })
  })

  describe('new client, old host', () => {
    it('does not offer the new agent to a host without the capability', () => {
      const host = oldHostCapabilities()
      expect(
        resolveStructuredNativeChatSupport({
          agent: NEW_AGENT,
          executionHostId: 'local',
          hostCapabilities: host,
          hostStructuredAgents: [NEW_AGENT],
          workspaceKind: 'git-worktree'
        })
      ).toEqual({ supported: false, blocker: 'runtime-capability' })
      // Claude and Codex are offered exactly when the old host serves structured chats at all.
      for (const agent of ['claude', 'codex'] as const) {
        expect(
          resolveStructuredNativeChatSupport({
            agent,
            executionHostId: 'local',
            hostCapabilities: host,
            workspaceKind: 'git-worktree'
          }).supported
        ).toBe(host.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY))
      }
    })

    it('would be refused by an old host that does not advertise the capability', async () => {
      if (
        baseline.wire.capabilities.includes(
          STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
        )
      ) {
        return
      }
      const replies: { ok: boolean; result?: unknown }[] = []
      await baseline.wire.createDispatcher(createSupportRuntime()).dispatchStreaming(
        {
          id: 'create-support',
          authToken: 'cross-version-token',
          method: 'agentSession.createSupport',
          params: { worktree: `id:${WORKTREE}`, agent: NEW_AGENT }
        },
        (raw) => replies.push(JSON.parse(raw)),
        { clientKind: 'runtime', clientCapabilities: baseline.wire.capabilities }
      )
      expect(replies).toHaveLength(1)
      expect(replies[0]?.ok).toBe(false)
    })
  })

  describe('Claude and Codex, both ways', () => {
    it('are accepted by both builds as before', async () => {
      for (const build of [current, baseline.wire]) {
        for (const agent of ['claude', 'codex']) {
          const replies: { ok: boolean; result?: unknown }[] = []
          await build.createDispatcher(createSupportRuntime()).dispatchStreaming(
            {
              id: `create-support-${agent}`,
              authToken: 'cross-version-token',
              method: 'agentSession.createSupport',
              params: { worktree: `id:${WORKTREE}`, agent }
            },
            (raw) => replies.push(JSON.parse(raw)),
            { clientKind: 'runtime', clientCapabilities: [...RUNTIME_CAPABILITIES] }
          )
          expect(replies, `${build.label}: ${agent}`).toEqual([
            expect.objectContaining({
              ok: true,
              result: expect.objectContaining({ supported: true })
            })
          ])
          if (
            build.capabilities.includes(STRUCTURED_AGENT_SESSION_CLIENT_OPTIONS_RUNTIME_CAPABILITY)
          ) {
            expect(replies[0]?.result).toMatchObject({ acceptsClientOptions: true })
          } else {
            expect(replies[0]?.result).not.toHaveProperty('acceptsClientOptions')
          }
        }
      }
    })

    it("reach today's desktop unchanged from a new host", () => {
      const payload = tabsSnapshot(['claude', 'codex'])
      expect(
        projectSessionTabAgentStatus(
          payload,
          'runtime',
          DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        )
      ).toBe(payload)
    })
  })
})

/** Enough of a runtime for createSupport to answer: the verdict itself is stubbed. */
function createSupportRuntime(): unknown {
  return {
    getRuntimeId: () => 'runtime-1',
    getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    structuredAgentSessionLaunchSeedOptions: () => undefined
  }
}
