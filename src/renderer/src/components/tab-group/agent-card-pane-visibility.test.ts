import { getDefaultSettings } from '../../../../shared/constants'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import {
  hiddenAgentCardGroupIds,
  isAgentCardPanePresentable,
  parseAgentCardPaneVisibility,
  reportAgentCardHidden,
  resetAgentCardHiddenForTests,
  selectAgentCardPaneVisibilityKey,
  trackedAgentCardHiddenWorktreeIdsForTests
} from './agent-card-pane-visibility'
import { afterEach, describe, expect, it } from 'vitest'

const WORKTREE_ID = 'wt-1'

function makeGroup(id: string, activeTabId: string): TabGroup {
  return { id, worktreeId: WORKTREE_ID, activeTabId, tabOrder: [activeTabId] }
}

function makeAgentsTab(groupId: string): Tab {
  return {
    id: 'agents-tab',
    entityId: `agents:${WORKTREE_ID}`,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'agents',
    label: 'Agents',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    isPinned: true
  }
}

function makeAgentTab(id: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function visibilityState(overrides: {
  experimentOn?: boolean
  cardGroupIds?: readonly string[]
  groups?: TabGroup[]
  tabs?: Tab[]
}) {
  return {
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalTiledAgents: overrides.experimentOn ?? true
    },
    agentCardGroupIdsByWorktree: {
      [WORKTREE_ID]: overrides.cardGroupIds ?? ['card-1']
    },
    groupsByWorktree: {
      [WORKTREE_ID]: overrides.groups ?? [
        makeGroup('home', 'agents-tab'),
        makeGroup('card-1', 't1')
      ]
    },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: overrides.tabs ?? [makeAgentsTab('home'), makeAgentTab('t1', 'card-1')]
    }
  }
}

describe('selectAgentCardPaneVisibilityKey', () => {
  afterEach(() => {
    resetAgentCardHiddenForTests()
  })

  it('returns empty on the experiment-off gate before reading cards or groups', () => {
    const state = visibilityState({ experimentOn: false })
    expect(selectAgentCardPaneVisibilityKey(state, WORKTREE_ID)).toBe('')
  })

  it('returns empty when the worktree has no card groups', () => {
    const state = visibilityState({ cardGroupIds: [] })
    expect(selectAgentCardPaneVisibilityKey(state, WORKTREE_ID)).toBe('')
  })

  it('reports grid on screen when the Agents tab is the home group active tab', () => {
    expect(selectAgentCardPaneVisibilityKey(visibilityState({}), WORKTREE_ID)).toBe('1||card-1')
  })

  it('reports grid off screen when the Agents tab is missing, even though undefined === undefined (B4)', () => {
    // Why: with no Agents tab, homeGroup is also undefined; the naive comparison
    // homeGroup?.activeTabId === agentsTab?.id reads undefined === undefined as true.
    const state = visibilityState({
      groups: [makeGroup('home', 't1'), makeGroup('card-1', 't1')],
      tabs: [makeAgentTab('t1', 'card-1')]
    })
    expect(selectAgentCardPaneVisibilityKey(state, WORKTREE_ID)).toBe('0||card-1')
  })

  it('reports grid off screen when the home group is showing a terminal', () => {
    const state = visibilityState({
      groups: [makeGroup('home', 'term-1'), makeGroup('card-1', 't1')],
      tabs: [
        makeAgentsTab('home'),
        makeAgentTab('t1', 'card-1'),
        {
          id: 'term-1',
          entityId: 'term-1',
          groupId: 'home',
          worktreeId: WORKTREE_ID,
          contentType: 'terminal',
          label: 'Terminal',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: 1
        }
      ]
    })
    expect(selectAgentCardPaneVisibilityKey(state, WORKTREE_ID)).toBe('0||card-1')
  })

  it('includes hidden card group ids from the intersection registry', () => {
    reportAgentCardHidden(WORKTREE_ID, 'card-1', true)
    expect(selectAgentCardPaneVisibilityKey(visibilityState({}), WORKTREE_ID)).toBe(
      '1|card-1|card-1'
    )
    expect(hiddenAgentCardGroupIds(WORKTREE_ID)).toEqual(['card-1'])
  })
})

describe('reportAgentCardHidden', () => {
  afterEach(() => {
    resetAgentCardHiddenForTests()
  })

  it('tracks no worktree for a card that only ever reports visible', () => {
    reportAgentCardHidden(WORKTREE_ID, 'card-1', false)
    expect(trackedAgentCardHiddenWorktreeIdsForTests()).toEqual([])
  })

  it('drops the worktree once its last hidden card scrolls back into view', () => {
    reportAgentCardHidden(WORKTREE_ID, 'card-1', true)
    reportAgentCardHidden(WORKTREE_ID, 'card-2', true)
    expect(trackedAgentCardHiddenWorktreeIdsForTests()).toEqual([WORKTREE_ID])

    reportAgentCardHidden(WORKTREE_ID, 'card-1', false)
    expect(trackedAgentCardHiddenWorktreeIdsForTests()).toEqual([WORKTREE_ID])
    reportAgentCardHidden(WORKTREE_ID, 'card-2', false)
    expect(trackedAgentCardHiddenWorktreeIdsForTests()).toEqual([])
  })
})

describe('parseAgentCardPaneVisibility', () => {
  it('parses an empty key to empty sets', () => {
    const parsed = parseAgentCardPaneVisibility('')
    expect(parsed.gridOnScreen).toBe(false)
    expect(parsed.cardGroupIds.size).toBe(0)
    expect(parsed.hiddenCardGroupIds.size).toBe(0)
  })

  it('round-trips a three-part key', () => {
    const parsed = parseAgentCardPaneVisibility('1|g2|g1,g2')
    expect(parsed.gridOnScreen).toBe(true)
    expect([...parsed.cardGroupIds]).toEqual(['g1', 'g2'])
    expect([...parsed.hiddenCardGroupIds]).toEqual(['g2'])
  })
})

describe('isAgentCardPanePresentable', () => {
  it('keeps ordinary tabs presentable', () => {
    const visibility = parseAgentCardPaneVisibility('0||card-1')
    expect(isAgentCardPanePresentable('home', visibility)).toBe(true)
  })

  it('hides a card when the Agents tab is not on screen (F1)', () => {
    const visibility = parseAgentCardPaneVisibility('0||card-1')
    expect(isAgentCardPanePresentable('card-1', visibility)).toBe(false)
  })

  it('hides a card scrolled out of the grid (F2)', () => {
    const visibility = parseAgentCardPaneVisibility('1|card-1|card-1')
    expect(isAgentCardPanePresentable('card-1', visibility)).toBe(false)
  })

  it('shows a card when the grid is on screen and the card is in view', () => {
    const visibility = parseAgentCardPaneVisibility('1||card-1')
    expect(isAgentCardPanePresentable('card-1', visibility)).toBe(true)
  })
})
