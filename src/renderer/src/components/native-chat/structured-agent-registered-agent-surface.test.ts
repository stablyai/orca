import { describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { AgentSessionCapabilities } from '../../../../shared/agent-session-capabilities'
import type { Tab } from '../../../../shared/tab-types'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}), subscribe: () => () => {} } }))

import { structuredAgentAcceptsImages } from '@/runtime/use-host-structured-agent'
import { isStructuredTab } from './structured-agent-session-tabs'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'

const chatTab = (agentSessionAgent: unknown) => ({
  id: 'agent-session:grok_1',
  entityId: 'grok_1',
  groupId: 'group-1',
  worktreeId: 'wt',
  contentType: 'agent-session',
  agentSessionAgent,
  label: 'Grok Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
})

function reloadedTab(agentSessionAgent: unknown): Tab {
  const parsed = parseWorkspaceSession({
    activeRepoId: null,
    activeWorktreeId: 'wt',
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: { wt: [chatTab(agentSessionAgent)] }
  })
  if (!parsed.ok || !parsed.value.unifiedTabs?.wt[0]) {
    throw new Error('session did not parse')
  }
  return parsed.value.unifiedTabs.wt[0]
}

describe('a host-registered agent on the structured chat surface', () => {
  it("renders a registered agent's chat tab, including after a reload", () => {
    expect(isStructuredTab(reloadedTab('grok'))).toBe(true)
    expect(isStructuredTab(reloadedTab('claude'))).toBe(true)
    // A malformed id degrades to no agent, which mounts no chat pane.
    expect(isStructuredTab(reloadedTab('not an agent!'))).toBe(false)
  })

  it("starts an unshipped agent's picker from no built-in list, so the host catalog or session fills it", () => {
    expect(structuredAgentSessionSeedCatalog('grok').models).toEqual([])
    expect(structuredAgentSessionSeedCatalog('claude')).toBe(getAgentSessionOptionCatalog('claude'))
    expect(structuredAgentSessionSeedCatalog('codex')).toBe(getAgentSessionOptionCatalog('codex'))
  })

  it("attaches images only when the host's record for the agent takes them", () => {
    const capabilities = (imagePrompts: boolean): AgentSessionCapabilities => ({
      rewind: false,
      compact: false,
      threadGoal: false,
      contextUsage: false,
      imagePrompts,
      steering: 'queue',
      approvalEnforcement: 'orca'
    })
    const record = (imagePrompts: boolean) => ({
      agent: 'grok',
      capabilities: capabilities(imagePrompts)
    })
    expect(structuredAgentAcceptsImages(record(false), 'grok')).toBe(false)
    expect(structuredAgentAcceptsImages(record(true), 'grok')).toBe(true)
    // Unlisted: an older host's built-ins keep images; any other agent claims none.
    expect(structuredAgentAcceptsImages(undefined, 'claude')).toBe(true)
    expect(structuredAgentAcceptsImages(undefined, 'grok')).toBe(false)
  })
})
