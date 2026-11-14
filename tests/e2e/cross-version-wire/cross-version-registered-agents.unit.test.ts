// Pair new registered agents across real builds: old clients must not render unknown chats or lose known tabs/records.
// Derive old capability lists from their checkout and remove the tested capability so rolling releases cannot erase the skew.

import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { projectSessionTabAgentStatus } from '../../../src/main/runtime/rpc/methods/session-tabs/session-tab-agent-status-projection'
import '../../../src/shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import '../../../src/shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import '../../../src/shared/agent-session/lifecycle/agent-session-record'
import '../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import '../../../src/shared/protocol-version'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/structured-agent-session-surface-capabilities'
import '../../../src/shared/agent-session/agent-session-runtime-capabilities'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../src/shared/runtime-types'
import '../../../src/shared/structured-native-chat-launch-route'
import { parseWorkspaceSession } from '../../../src/shared/workspace-session/workspace-session-schema'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef,
  type ReleaseCheckout,
  releaseModuleExport
} from './release-checkout'
import {
  loadAgentSessionWireBuild,
  type AgentSessionWireBuild
} from './versioned-agent-session-wire'

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
}

let baseline: Baseline

// v1.4.228 moved `isStructuredTab` to shared code; keeping both locations lets the rolling baseline
// cross that move and an older pinned ref still load.
const BASELINE_STRUCTURED_TAB_SOURCES = [
  'src/shared/structured-agent-session-tab.ts',
  'src/renderer/src/components/native-chat/structured-agent-session-tabs.ts'
] as const

async function importBaselineStructuredTab(
  checkout: ReleaseCheckout
): Promise<Record<string, unknown>> {
  for (const file of BASELINE_STRUCTURED_TAB_SOURCES) {
    const loaded = await importReleaseCheckoutModule(checkout, file).catch(() => null)
    if (loaded?.isStructuredTab !== undefined) {
      return loaded
    }
  }
  throw new Error(
    `the baseline release exports no isStructuredTab (tried ${BASELINE_STRUCTURED_TAB_SOURCES.join(', ')})`
  )
}

beforeAll(async () => {
  const ref = resolveBaselineReleaseRef()
  const checkout = await materializeReleaseCheckout(ref)
  const [capabilities, projection, schema, tabs] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/ipc/desktop-renderer-runtime-capabilities.ts'),
    importReleaseCheckoutModule(
      checkout,
      'src/main/runtime/rpc/methods/session-tab-agent-status-projection.ts'
    ),
    importReleaseCheckoutModule(checkout, 'src/shared/workspace-session-schema.ts'),
    importBaselineStructuredTab(checkout)
  ])
  const wire = await loadAgentSessionWireBuild(ref)
  baseline = {
    ref,
    wire,
    desktopClientCapabilities: releaseModuleExport(
      capabilities,
      'DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES'
    ),
    projectSessionTabAgentStatus: releaseModuleExport(projection, 'projectSessionTabAgentStatus'),
    parseWorkspaceSession: releaseModuleExport(schema, 'parseWorkspaceSession'),
    isStructuredTab: releaseModuleExport(tabs, 'isStructuredTab')
  }
}, SUITE_TIMEOUT_MS)

/** Whether a build's saved tabs support open agent ids. */
function registersAgents(build: AgentSessionWireBuild): boolean {
  return build.capabilities.includes(STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY)
}

// Remove the new capability from the checkout’s real list so the client remains effectively old after release.
function oldDesktopClientCapabilities(): string[] {
  return baseline.desktopClientCapabilities.filter(
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

/** A parsed session's chat tabs in the test worktree, read through a named shape. */
const parsedSessionTabs = z.object({
  unifiedTabs: z.record(z.string(), z.array(z.record(z.string(), z.unknown())))
})

function unifiedTabsOf(parsed: { ok: boolean; value?: unknown }): Record<string, unknown>[] {
  const session = parsedSessionTabs.safeParse(parsed.value)
  return session.success ? (session.data.unifiedTabs[WORKTREE] ?? []) : []
}

describe('a structured agent beyond Claude and Codex, across versions', () => {
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
  })
})
