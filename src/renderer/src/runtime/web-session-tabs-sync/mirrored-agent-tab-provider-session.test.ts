// The host owns the conversation identity; the client owns the name it resolved from that
// identity. A republish must carry the first through and must not discard the second.

import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { buildMirroredAgentTabs } from './terminal-surfaces'

const WORKTREE = 'repo-1::worktree-1'
const GROUP = 'group-1'
const PROVIDER_SESSION = 'provider-session-1'

function snapshotWith(providerSessionId?: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: GROUP,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'host-tab-1',
        title: 'Claude Chat',
        sessionId: 'session-1',
        agent: 'claude',
        ...(providerSessionId ? { providerSessionId } : {}),
        isActive: false
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function build(
  snapshot: RuntimeMobileSessionTabsResult,
  currentUnifiedTabs: readonly Tab[] = []
): Tab {
  return buildMirroredAgentTabs(snapshot, new Map(), GROUP, 0, currentUnifiedTabs, 1_000)[0]!
    .unifiedTab
}

const RESOLVED = { agent: 'claude' as const, sessionId: PROVIDER_SESSION, title: 'Fix the probe' }

describe('structured chat provider identity across republishes', () => {
  it('carries the published provider conversation onto the chat row', () => {
    expect(build(snapshotWith(PROVIDER_SESSION)).agentSessionProviderSessionId).toBe(
      PROVIDER_SESSION
    )
  })

  it('omits the field entirely until the provider proves a conversation', () => {
    const tab = build(snapshotWith())
    expect(tab.label).toBe('Claude Chat')
    expect('agentSessionProviderSessionId' in tab).toBe(false)
  })

  it('treats a blank published id as unproven rather than as an empty conversation', () => {
    expect('agentSessionProviderSessionId' in build(snapshotWith('   '))).toBe(false)
  })

  it('keeps a name already resolved for the same conversation, so a restored chat shows it at once', () => {
    const restored: Tab = {
      ...build(snapshotWith(PROVIDER_SESSION)),
      aiVaultTitle: RESOLVED
    }
    expect(build(snapshotWith(PROVIDER_SESSION), [restored]).aiVaultTitle).toEqual(RESOLVED)
  })

  it('drops a name resolved for a different conversation', () => {
    const forked: Tab = {
      ...build(snapshotWith(PROVIDER_SESSION)),
      aiVaultTitle: { ...RESOLVED, sessionId: 'some-other-conversation' }
    }
    expect(build(snapshotWith(PROVIDER_SESSION), [forked]).aiVaultTitle).toBeUndefined()
  })

  it('persists both the conversation id and the resolved name across a restart', () => {
    const tab = { ...build(snapshotWith(PROVIDER_SESSION)), aiVaultTitle: RESOLVED }
    const parsed = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: WORKTREE,
      activeTabId: tab.id,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      unifiedTabs: { [WORKTREE]: [tab] }
    })
    expect(parsed.ok).toBe(true)
    const restored = parsed.ok ? parsed.value.unifiedTabs?.[WORKTREE]?.[0] : undefined
    expect(restored?.agentSessionProviderSessionId).toBe(PROVIDER_SESSION)
    expect(restored?.aiVaultTitle).toEqual(RESOLVED)
  })
})
