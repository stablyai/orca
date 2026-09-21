import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { buildMirroredAgentTabs } from './terminal-surfaces'

const WORKTREE = 'repo-1::worktree-1'
const GROUP = 'group-1'

function snapshotWith(agent: 'claude' | 'codex', title: string): RuntimeMobileSessionTabsResult {
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
        title,
        sessionId: `${agent}-1`,
        agent,
        isActive: false
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function build(
  snapshot: RuntimeMobileSessionTabsResult,
  currentUnifiedTabs: readonly Tab[] = []
): Tab {
  const [mirrored] = buildMirroredAgentTabs(
    snapshot,
    new Map(),
    GROUP,
    0,
    currentUnifiedTabs,
    1_000
  )
  return mirrored.unifiedTab
}

describe('buildMirroredAgentTabs', () => {
  it('falls back to the agent-specific placeholder when the host publishes no title', () => {
    expect(build(snapshotWith('claude', '')).label).toBe('Claude Chat')
    expect(build(snapshotWith('codex', '   ')).label).toBe('Codex Chat')
  })

  it('prefers the host title over the placeholder', () => {
    expect(build(snapshotWith('claude', 'Flaky retry test')).label).toBe('Flaky retry test')
  })

  it('keeps a manual rename across host snapshots', () => {
    const snapshot = snapshotWith('codex', 'Codex Chat')
    const renamed = build(snapshot)
    const existing: Tab = { ...renamed, customLabel: 'My rename' }
    expect(build(snapshot, [existing]).customLabel).toBe('My rename')
  })

  it('leaves customLabel null when the tab was never renamed', () => {
    // Guard: assert the row is actually built, so this cannot pass on an empty
    // result the way a bare null-check would.
    const tab = build(snapshotWith('codex', 'Codex Chat'))
    expect(tab.label).toBe('Codex Chat')
    expect(tab.customLabel).toBeNull()
  })

  it('degrades to the placeholder when the host violates the string contract', () => {
    const snapshot = snapshotWith('claude', 'Named')
    // The wire type says `string`, but a host clearing a name can send null.
    ;(snapshot.tabs[0] as { title: unknown }).title = null
    expect(() => build(snapshot)).not.toThrow()
    expect(build(snapshot).label).toBe('Claude Chat')
  })

  it('names an agent this build does not know after itself, not Codex', () => {
    const snapshot = snapshotWith('codex', '')
    // Cast: the wire union is claude|codex today, but Tab.agentSessionAgent is
    // the open AgentType, so a future agent can reach this label.
    ;(snapshot.tabs[0] as { agent: string }).agent = 'gemini'
    expect(build(snapshot).label).toBe('Gemini Chat')
  })
})
