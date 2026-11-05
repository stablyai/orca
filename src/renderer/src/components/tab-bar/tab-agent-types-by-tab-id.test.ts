import { describe, expect, it } from 'vitest'

import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { mulberry32 } from '../../../../shared/agent-tui-ansi-fuzz-stream'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'

import {
  createTabBarAgentProjectionSelector,
  selectNativeChatTabWideFallbackUnsafeTabsById,
  selectTabAgentTypesByTabId
} from './tab-agent-types-by-tab-id'

function entry(partial: Partial<AgentStatusEntry>): AgentStatusEntry {
  return { state: 'working', updatedAt: 0, ...partial } as AgentStatusEntry
}

function splitLayout(activeLeafId: string | null): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    },
    activeLeafId,
    expandedLeafId: null
  }
}

describe('selectTabAgentTypesByTabId', () => {
  it('patches incrementally to the same result as a full projection', () => {
    // Why: an LCG multiply past 2^53 loses low bits and collapses the picks onto a few cases.
    const nextRandom = mulberry32(7)
    const random = (limit: number): number => Math.floor(nextRandom() * limit)
    const tabCount = 8
    const agents = ['claude', 'codex', 'grok', undefined] as const
    const leaves = ['leaf-a', 'leaf-b', 'leaf-c'] as const
    const layoutChoices: TerminalLayoutSnapshot[] = [
      splitLayout('leaf-a'),
      splitLayout('leaf-b'),
      splitLayout(null),
      splitLayout('leaf-c'),
      {
        root: { type: 'leaf', leafId: 'leaf-b' },
        activeLeafId: 'leaf-b',
        expandedLeafId: null
      },
      { root: null, activeLeafId: 'leaf-a', expandedLeafId: null },
      { root: null, activeLeafId: null, expandedLeafId: null }
    ]
    const select = createTabBarAgentProjectionSelector()
    let statuses: Record<string, AgentStatusEntry> = {}
    let layouts: Record<string, TerminalLayoutSnapshot> = {}
    const seenTabIds = new Set<string>()
    const seenAgents = new Set<(typeof agents)[number]>()
    const seenLayouts = new Set<TerminalLayoutSnapshot>()
    const appliedOperations = new Set<number>()
    for (let step = 0; step < 2_000; step++) {
      const tabId = `tab-${random(tabCount)}`
      const paneKey = `${tabId}:${leaves[random(leaves.length)]}`
      const operation = random(7)
      seenTabIds.add(tabId)
      // A status ping for a missing pane falls through, like operation 6, to reselect unchanged inputs.
      if (operation !== 1 || statuses[paneKey]) {
        appliedOperations.add(operation)
      }
      if (operation === 0) {
        const agentType = agents[random(agents.length)]
        seenAgents.add(agentType)
        statuses = { ...statuses, [paneKey]: entry({ agentType }) }
      } else if (operation === 1 && statuses[paneKey]) {
        statuses = {
          ...statuses,
          [paneKey]: { ...statuses[paneKey], state: 'done' }
        }
      } else if (operation === 2) {
        const { [paneKey]: _removed, ...rest } = statuses
        statuses = rest
      } else if (operation === 3) {
        // Same keys and entries in a new insertion order.
        statuses = Object.fromEntries(Object.entries(statuses).toReversed())
      } else if (operation === 4) {
        const layout = layoutChoices[random(layoutChoices.length)]!
        seenLayouts.add(layout)
        layouts = { ...layouts, [tabId]: layout }
      } else if (operation === 5) {
        const { [tabId]: _removed, ...rest } = layouts
        layouts = rest
      }
      const result = select({
        agentStatusByPaneKey: statuses,
        terminalLayoutsByTabId: layouts
      })
      expect(result.tabAgentTypesByTabId).toEqual(selectTabAgentTypesByTabId(statuses, layouts))
      expect(result.nativeChatTabWideFallbackUnsafeTabsById).toEqual(
        selectNativeChatTabWideFallbackUnsafeTabsById(layouts)
      )
    }
    // Why: a degenerate generator silently narrows the differential check, so pin what it exercised.
    expect(seenTabIds.size).toBe(tabCount)
    expect(seenAgents).toEqual(new Set(agents))
    expect(seenLayouts).toEqual(new Set(layoutChoices))
    expect(appliedOperations).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]))
  })
})
