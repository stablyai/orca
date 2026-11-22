import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { buildMirroredAgentTabs } from './terminal-surfaces'

const PAGE = 'folder:bot-home'

function served(isPinned?: boolean): RuntimeMobileSessionTabsResult {
  return {
    worktree: PAGE,
    publicationEpoch: 'headless',
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'agent-session:side',
        title: 'Side',
        sessionId: 'side',
        agent: 'claude',
        isActive: false,
        ...(isPinned !== undefined ? { isPinned } : {})
      }
    ]
  }
}

/** The side chat this desktop pinned before its host kept the Home rule. */
const pinnedHere = {
  id: 'side-view',
  entityId: 'side',
  groupId: 'group',
  worktreeId: PAGE,
  executionHostId: 'runtime:server',
  contentType: 'agent-session',
  label: 'Side',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  isPinned: true
} satisfies Tab

function pinAfter(isPinned?: boolean): boolean | undefined {
  return buildMirroredAgentTabs(
    served(isPinned),
    'runtime:server',
    new Map(),
    'group',
    0,
    [pinnedHere],
    2
  )[0]?.unifiedTab.isPinned
}

describe("a paired server's chat pin on this desktop", () => {
  it('clears a local pin when the host says false, and keeps it when an older host says nothing', () => {
    expect(pinAfter(false)).toBe(false)
    expect(pinAfter(undefined)).toBe(true)
  })
})
