import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore, makeTab } from './store-test-helpers'
import { AGENT_CARDS_MAX } from './tabs/agent-card-tabs'
import { collectLayoutLeafGroupIds } from './tabs/agent-cards-projection'
import { buildPersistedUnifiedTabSessionData } from '../../lib/workspace-session-unified-tabs'

function enableAgentCards(store: ReturnType<typeof createTestStore>): void {
  store.setState({ settings: { ...getDefaultSettings('/tmp'), experimentalTiledAgents: true } })
}

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('agent card actions', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  function createAgentTabs(count: number): string[] {
    return Array.from(
      { length: count },
      (_, i) =>
        store.getState().createUnifiedTab(WT, 'agent-session', { id: `a${i}`, label: `Agent ${i}` })
          .id
    )
  }

  function createTerminalAgentTabs(count: number): string[] {
    const ids = Array.from({ length: count }, (_, i) => `t${i}`)
    for (const id of ids) {
      store.getState().createUnifiedTab(WT, 'terminal', { id, label: `Agent ${id}` })
    }
    store.setState({
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [WT]: ids.map((id) => makeTab({ id, worktreeId: WT, launchAgent: 'claude' }))
      }
    })
    return ids
  }

  it('is inert when the experiment is off', () => {
    createAgentTabs(2)
    const before = store.getState()
    expect(store.getState().resolveAgentLaunchGroupId(WT, 'home')).toBe('home')
    const result = store.getState().syncAgentCards(WT)
    expect(result).toEqual({ carded: false, overflowTabIds: [] })
    expect(store.getState()).toBe(before)
  })

  it('cards three CLI agents without writing layout, and a second sync is a slice-identity no-op', () => {
    enableAgentCards(store)
    const ids = createTerminalAgentTabs(3)
    const layoutBefore = store.getState().layoutByWorktree[WT]

    const result = store.getState().syncAgentCards(WT)

    expect(result).toEqual({ carded: true, overflowTabIds: [] })
    const state = store.getState()
    expect(state.layoutByWorktree[WT]).toBe(layoutBefore)
    expect(
      state.unifiedTabsByWorktree[WT].filter((tab) => tab.contentType === 'agents')
    ).toHaveLength(1)
    const cardGroupIds = state.agentCardGroupIdsByWorktree[WT] ?? []
    expect(cardGroupIds).toHaveLength(3)
    expect(collectLayoutLeafGroupIds(state.layoutByWorktree[WT]).has(cardGroupIds[0])).toBe(false)
    for (const id of ids) {
      const tab = state.unifiedTabsByWorktree[WT].find((item) => item.id === id)
      expect(cardGroupIds).toContain(tab?.groupId)
    }

    const groupsBefore = store.getState().groupsByWorktree
    const layoutAfter = store.getState().layoutByWorktree
    const tabsBefore = store.getState().unifiedTabsByWorktree
    const cardsBefore = store.getState().agentCardGroupIdsByWorktree
    const second = store.getState().syncAgentCards(WT)
    expect(second).toEqual({ carded: true, overflowTabIds: [] })
    expect(store.getState().groupsByWorktree).toBe(groupsBefore)
    expect(store.getState().layoutByWorktree).toBe(layoutAfter)
    expect(store.getState().unifiedTabsByWorktree).toBe(tabsBefore)
    expect(store.getState().agentCardGroupIdsByWorktree).toBe(cardsBefore)
  })

  it('leaves a tenth agent as an ordinary tab in overflowTabIds', () => {
    enableAgentCards(store)
    createAgentTabs(AGENT_CARDS_MAX + 1)
    const result = store.getState().syncAgentCards(WT)
    expect(result.overflowTabIds).toEqual(['a9'])
    const overflow = store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === 'a9')
    expect(store.getState().agentCardGroupIdsByWorktree[WT]).not.toContain(overflow?.groupId)
  })

  it('restoreAgentCardsAsTabs returns agents to the home group and keeps sessions alive', () => {
    enableAgentCards(store)
    const ids = createAgentTabs(3)
    store.getState().syncAgentCards(WT)
    const terminal = store
      .getState()
      .createUnifiedTab(WT, 'terminal', { id: 'term', label: 'Term' })
    const editor = store.getState().createUnifiedTab(WT, 'editor', { id: 'ed', label: 'File' })
    const browser = store.getState().createUnifiedTab(WT, 'browser', { id: 'br', label: 'Web' })
    const diff = store.getState().createUnifiedTab(WT, 'diff', { id: 'df', label: 'Diff' })
    const terminalGroup = terminal.groupId
    const editorGroup = editor.groupId
    const browserGroup = browser.groupId
    const diffGroup = diff.groupId

    store.getState().restoreAgentCardsAsTabs(WT)

    const state = store.getState()
    expect(state.unifiedTabsByWorktree[WT].some((tab) => tab.contentType === 'agents')).toBe(false)
    expect(state.agentCardGroupIdsByWorktree[WT]).toBeUndefined()
    for (const id of ids) {
      expect(state.unifiedTabsByWorktree[WT].some((tab) => tab.id === id)).toBe(true)
    }
    expect(state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'term')?.groupId).toBe(
      terminalGroup
    )
    expect(state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'ed')?.groupId).toBe(
      editorGroup
    )
    expect(state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'br')?.groupId).toBe(
      browserGroup
    )
    expect(state.unifiedTabsByWorktree[WT].find((tab) => tab.id === 'df')?.groupId).toBe(diffGroup)
  })

  it('createAgentCardGroup does not write layout', () => {
    enableAgentCards(store)
    createAgentTabs(1)
    const layoutBefore = store.getState().layoutByWorktree
    store.getState().resolveAgentLaunchGroupId(WT, store.getState().groupsByWorktree[WT][0].id)
    expect(store.getState().layoutByWorktree).toBe(layoutBefore)
  })

  describe('N1: registry written at mint time (no surface mounted)', () => {
    it('registers the minted card group immediately, without syncAgentCards ever running', () => {
      enableAgentCards(store)
      // Why: mirrors launchAgentInNewTab / openStructuredAgentSessionProvisionalTab calling
      // resolveAgentLaunchGroupId directly for a worktree whose WorktreeSplitSurface (and so
      // useAgentCardsReconciler, the only production caller of syncAgentCards) is not mounted.
      const mintedGroupId = store.getState().resolveAgentLaunchGroupId(WT, undefined)
      expect(mintedGroupId).toBeTruthy()
      expect(store.getState().agentCardGroupIdsByWorktree[WT]).toContain(mintedGroupId)
    })

    it('strips the card group from the persisted session and projects the tab back to an ordinary tab', () => {
      enableAgentCards(store)
      const mintedGroupId = store.getState().resolveAgentLaunchGroupId(WT, undefined)
      const launched = store.getState().createUnifiedTab(WT, 'agent-session', {
        id: 'launched-agent',
        label: 'Launched Agent',
        targetGroupId: mintedGroupId
      })
      expect(launched.groupId).toBe(mintedGroupId)

      const payload = buildPersistedUnifiedTabSessionData(store.getState())
      const persistedGroups = payload.tabGroups?.[WT] ?? []
      const persistedTabs = payload.unifiedTabs?.[WT] ?? []
      expect(persistedGroups.some((persistedGroup) => persistedGroup.id === mintedGroupId)).toBe(
        false
      )
      const persistedTab = persistedTabs.find((item) => item.id === launched.id)
      expect(persistedTab).toBeDefined()
      expect(
        persistedGroups.some((persistedGroup) => persistedGroup.id === persistedTab?.groupId)
      ).toBe(true)
    })

    it('turning the setting off restores the tab as an ordinary tab in the home group with no orphan group', () => {
      enableAgentCards(store)
      const mintedGroupId = store.getState().resolveAgentLaunchGroupId(WT, undefined)
      const homeGroupId = store
        .getState()
        .unifiedTabsByWorktree[WT].find((item) => item.contentType === 'agents')?.groupId
      const launched = store.getState().createUnifiedTab(WT, 'agent-session', {
        id: 'launched-agent',
        label: 'Launched Agent',
        targetGroupId: mintedGroupId
      })

      store.setState({
        settings: { ...store.getState().settings!, experimentalTiledAgents: false }
      })
      store.getState().syncAgentCards(WT)

      const state = store.getState()
      expect(state.unifiedTabsByWorktree[WT].some((item) => item.contentType === 'agents')).toBe(
        false
      )
      const restored = state.unifiedTabsByWorktree[WT].find((item) => item.id === launched.id)
      expect(restored?.groupId).toBe(homeGroupId)
      expect(state.groupsByWorktree[WT]?.some((group) => group.id === mintedGroupId)).toBe(false)
      expect(state.agentCardGroupIdsByWorktree[WT]).toBeUndefined()
    })

    it('re-registers a card group whose registry entry was lost (e.g. hydrated legacy state)', () => {
      // Why: covers a group that already looks like a card group (off-layout, alone, only
      // agent tabs) but whose registry entry is missing - self-heal must recover it during
      // the next sync instead of leaving it to persist as an ordinary off-layout group.
      enableAgentCards(store)
      createAgentTabs(1)
      store.getState().syncAgentCards(WT)
      const cardGroupId = store.getState().agentCardGroupIdsByWorktree[WT]?.[0]
      expect(cardGroupId).toBeTruthy()

      store.setState((current) => {
        const { [WT]: _removed, ...rest } = current.agentCardGroupIdsByWorktree
        return { agentCardGroupIdsByWorktree: rest }
      })
      expect(store.getState().agentCardGroupIdsByWorktree[WT]).toBeUndefined()

      store.getState().syncAgentCards(WT)

      expect(store.getState().agentCardGroupIdsByWorktree[WT]).toContain(cardGroupId)
    })
  })

  describe('card group lifecycle', () => {
    it('rolls the minted group back when the tab move into it fails', () => {
      enableAgentCards(store)
      createAgentTabs(1)
      store.setState({ moveUnifiedTabToGroup: () => false })

      store.getState().syncAgentCards(WT)

      const state = store.getState()
      expect(state.agentCardGroupIdsByWorktree[WT] ?? []).toEqual([])
      expect(state.groupsByWorktree[WT].every((group) => group.tabOrder.length > 0)).toBe(true)
    })

    it('keeps the card registry when there is no layout to restore into', () => {
      enableAgentCards(store)
      createAgentTabs(1)
      store.getState().syncAgentCards(WT)
      const cardGroupIds = store.getState().agentCardGroupIdsByWorktree[WT] ?? []
      expect(cardGroupIds).toHaveLength(1)
      store.setState((current) => {
        const { [WT]: _removed, ...rest } = current.layoutByWorktree
        return { layoutByWorktree: rest }
      })

      expect(store.getState().restoreAgentCardsAsTabs(WT)).toBe(false)

      const state = store.getState()
      expect(state.agentCardGroupIdsByWorktree[WT]).toEqual(cardGroupIds)
      expect(state.groupsByWorktree[WT].some((group) => group.id === cardGroupIds[0])).toBe(true)
    })

    it('un-cards once a layout exists again, so the no-layout wait cannot become permanent', () => {
      enableAgentCards(store)
      createAgentTabs(1)
      store.getState().syncAgentCards(WT)
      const cardGroupIds = store.getState().agentCardGroupIdsByWorktree[WT] ?? []
      const layout = store.getState().layoutByWorktree[WT]
      store.setState((current) => {
        const { [WT]: _removed, ...rest } = current.layoutByWorktree
        return { layoutByWorktree: rest }
      })
      expect(store.getState().restoreAgentCardsAsTabs(WT)).toBe(false)

      // Why: the early return holds the registry rather than wiping it, so disabling the
      // experiment must still take effect the moment a layout is written back.
      store.setState((current) => ({
        layoutByWorktree: { ...current.layoutByWorktree, [WT]: layout }
      }))

      expect(store.getState().restoreAgentCardsAsTabs(WT)).toBe(true)
      const state = store.getState()
      expect(state.agentCardGroupIdsByWorktree[WT]).toBeUndefined()
      expect(state.groupsByWorktree[WT].some((group) => cardGroupIds.includes(group.id))).toBe(
        false
      )
    })

    it('recreates a missing Agents tab in a group the layout renders, not in a card group', () => {
      enableAgentCards(store)
      // The exact shape seen live after the pinned Agents tab is closed: the agents already sit
      // in off-layout card groups and the only rendered group is the now-empty home group.
      const homeGroupId = 'g-home'
      const cardGroupIds = ['g-card-0', 'g-card-1']
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: cardGroupIds.map((groupId, index) => ({
            id: `a${index}`,
            entityId: `a${index}`,
            groupId,
            worktreeId: WT,
            contentType: 'agent-session',
            label: `Agent ${index}`,
            customLabel: null,
            color: null,
            sortOrder: index,
            createdAt: index + 1
          }))
        },
        groupsByWorktree: {
          [WT]: [
            { id: homeGroupId, worktreeId: WT, activeTabId: null, tabOrder: [] },
            ...cardGroupIds.map((id, index) => ({
              id,
              worktreeId: WT,
              activeTabId: `a${index}`,
              tabOrder: [`a${index}`]
            }))
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: homeGroupId } },
        activeGroupIdByWorktree: { [WT]: homeGroupId },
        agentCardGroupIdsByWorktree: { [WT]: cardGroupIds },
        tabsByWorktree: { [WT]: [] }
      })

      store.getState().syncAgentCards(WT)

      const state = store.getState()
      const agentsTab = (state.unifiedTabsByWorktree[WT] ?? []).find(
        (tab) => tab.contentType === 'agents'
      )
      expect(agentsTab).toBeDefined()
      // Why this matters: falling back to an agent tab's group would put the Agents tab inside a
      // card group, which is deliberately off-layout, so nothing would render it.
      expect(agentsTab?.groupId).toBe(homeGroupId)
      expect(collectLayoutLeafGroupIds(state.layoutByWorktree[WT]).has(agentsTab!.groupId)).toBe(
        true
      )
      expect(cardGroupIds).not.toContain(agentsTab?.groupId)
    })

    it('closeAllAgentCards ends only the agents the tab hosts, not overflow agents', () => {
      enableAgentCards(store)
      const agentIds = createAgentTabs(AGENT_CARDS_MAX + 2)
      const overflowIds = agentIds.slice(AGENT_CARDS_MAX)
      store.getState().syncAgentCards(WT)
      const cardGroupIds = store.getState().agentCardGroupIdsByWorktree[WT] ?? []
      expect(cardGroupIds).toHaveLength(AGENT_CARDS_MAX)

      const closed = store.getState().closeAllAgentCards(WT)

      // Why: past the cap the extra agents stay ordinary top-level tabs, and closing the tab
      // they are not in must not end them.
      expect(closed).toBe(AGENT_CARDS_MAX)
      const remaining = (store.getState().unifiedTabsByWorktree[WT] ?? [])
        .filter((tab) => tab.contentType === 'agent-session')
        .map((tab) => tab.id)
      // Identity, not just count: closing the carded nine and leaving the overflow two is the
      // whole point, and a count alone passes when exactly the wrong two survive.
      expect(remaining).toEqual(overflowIds)
    })

    it('still clears a stale registry when the worktree has no cards to restore', () => {
      enableAgentCards(store)
      store.setState({
        agentCardGroupIdsByWorktree: { [WT]: [] },
        maximizedGroupIdByWorktree: { [WT]: 'stale-card' }
      })

      expect(store.getState().restoreAgentCardsAsTabs(WT)).toBe(false)

      expect(store.getState().agentCardGroupIdsByWorktree[WT]).toBeUndefined()
      expect(store.getState().maximizedGroupIdByWorktree[WT]).toBeUndefined()
    })
  })

  it('does not record agents in activeTabTypeByWorktree', () => {
    enableAgentCards(store)
    createAgentTabs(1)
    store.getState().syncAgentCards(WT)
    const agentsTab = store
      .getState()
      .unifiedTabsByWorktree[WT].find((tab) => tab.contentType === 'agents')
    expect(agentsTab).toBeTruthy()
    store.getState().activateTab(agentsTab!.id, { worktreeId: WT })
    expect(store.getState().activeTabTypeByWorktree[WT]).not.toBe('agents')
  })
})
