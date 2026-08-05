import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab, WorkspaceSessionState } from '../../../shared/types'
import { buildHydratedTabState } from '../store/slices/tabs-hydration'
import {
  collectDirectSshLegacyTabWorktreeIds,
  repairUnifiedTabMembershipFromLegacyTabs
} from './unified-tab-membership-repair'

const WORKTREE_ID = 'repo-1::/home/atlas-eval'

function legacyTab(id: string, ptyId: string | null, sortOrder = 0): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: `Terminal ${sortOrder + 1}`,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function sessionWithEmptyUnifiedMaps(
  tabs: TerminalTab[],
  overrides: Partial<WorkspaceSessionState> = {}
): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: tabs },
    unifiedTabs: { [WORKTREE_ID]: [] },
    tabGroups: { [WORKTREE_ID]: [] },
    ...overrides
  }
}

describe('repairUnifiedTabMembershipFromLegacyTabs', () => {
  it('materializes PTY-bound legacy tabs into a new unified group', () => {
    const bound = legacyTab('tab-claude', 'ssh:target-1@@pty-42', 15)
    const unbound = legacyTab('tab-blank', null, 2)
    const session = sessionWithEmptyUnifiedMaps([unbound, bound], {
      activeTabIdByWorktree: { [WORKTREE_ID]: bound.id }
    })

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    const tabs = repaired.unifiedTabs![WORKTREE_ID]
    expect(tabs.map((tab) => tab.id)).toEqual([bound.id])
    expect(tabs[0]).toMatchObject({
      entityId: bound.id,
      contentType: 'terminal',
      label: bound.title,
      worktreeId: WORKTREE_ID
    })
    const groups = repaired.tabGroups![WORKTREE_ID]
    expect(groups).toHaveLength(1)
    expect(groups[0].tabOrder).toEqual([bound.id])
    expect(groups[0].activeTabId).toBe(bound.id)
    expect(repaired.activeGroupIdByWorktree?.[WORKTREE_ID]).toBe(groups[0].id)

    // The hydrator that renders visible tabs must pick the repaired entries up.
    const hydrated = buildHydratedTabState(repaired, new Set([WORKTREE_ID]))
    expect(hydrated.unifiedTabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([bound.id])
  })

  it('counts layout leaf bindings and relay session ids as PTY evidence', () => {
    const layoutBound = legacyTab('tab-split', null, 0)
    const relayBound = legacyTab('tab-relay', null, 1)
    const session = sessionWithEmptyUnifiedMaps([layoutBound, relayBound], {
      terminalLayoutsByTabId: {
        [layoutBound.id]: {
          root: { type: 'leaf', leafId: 'leaf-1' },
          ptyIdsByLeafId: { 'leaf-1': 'ssh:target-1@@pty-9' }
        } as never
      },
      remoteSessionIdsByTabId: { [relayBound.id]: 'pty-10' }
    })

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    expect(repaired.unifiedTabs![WORKTREE_ID].map((tab) => tab.id)).toEqual([
      layoutBound.id,
      relayBound.id
    ])
  })

  it('appends missing tabs to the existing active group without duplicating unified tabs', () => {
    const alreadyUnified = legacyTab('tab-known', 'ssh:target-1@@pty-1', 0)
    const missing = legacyTab('tab-missing', 'ssh:target-1@@pty-2', 1)
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [alreadyUnified, missing] },
      unifiedTabs: {
        [WORKTREE_ID]: [
          {
            id: alreadyUnified.id,
            entityId: alreadyUnified.id,
            groupId: 'group-1',
            worktreeId: WORKTREE_ID,
            contentType: 'terminal',
            label: 'Known',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [WORKTREE_ID]: [
          {
            id: 'group-1',
            worktreeId: WORKTREE_ID,
            activeTabId: alreadyUnified.id,
            tabOrder: [alreadyUnified.id]
          }
        ]
      },
      activeGroupIdByWorktree: { [WORKTREE_ID]: 'group-1' }
    }

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    expect(repaired.unifiedTabs![WORKTREE_ID].map((tab) => tab.id)).toEqual([
      alreadyUnified.id,
      missing.id
    ])
    const group = repaired.tabGroups![WORKTREE_ID][0]
    expect(group.tabOrder).toEqual([alreadyUnified.id, missing.id])
    expect(group.activeTabId).toBe(alreadyUnified.id)
  })

  it('never resurrects unbound stale tabs', () => {
    const unbound = legacyTab('tab-blank', null, 0)
    const session = sessionWithEmptyUnifiedMaps([unbound])

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    expect(repaired).toBe(session)
  })

  it('leaves legacy-only sessions untouched so legacy hydration stays authoritative', () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [WORKTREE_ID]: [legacyTab('tab-legacy', 'ssh:target-1@@pty-3', 0)] }
    }

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    expect(repaired).toBe(session)
  })

  it('only scopes repair to the requested worktrees', () => {
    const otherWorktreeId = 'repo-1::/home/other'
    const bound = legacyTab('tab-claude', 'ssh:target-1@@pty-42', 0)
    const session: WorkspaceSessionState = {
      ...sessionWithEmptyUnifiedMaps([]),
      tabsByWorktree: {
        [otherWorktreeId]: [{ ...bound, worktreeId: otherWorktreeId }]
      }
    }

    const repaired = repairUnifiedTabMembershipFromLegacyTabs(session, {
      worktreeIds: new Set([WORKTREE_ID])
    })

    expect(repaired).toBe(session)
  })
})

describe('collectDirectSshLegacyTabWorktreeIds', () => {
  it('collects worktrees only from direct-SSH slices', () => {
    const slices = {
      local: {
        tabsByWorktree: { 'repo-1::/local': [] }
      },
      'ssh:target-1': {
        tabsByWorktree: { [WORKTREE_ID]: [] }
      },
      'runtime:env-1': {
        tabsByWorktree: { 'repo-2::/srv/remote': [] }
      }
    }

    expect([...collectDirectSshLegacyTabWorktreeIds(slices)]).toEqual([WORKTREE_ID])
  })
})
