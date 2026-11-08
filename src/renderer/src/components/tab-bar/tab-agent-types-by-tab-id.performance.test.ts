import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/workspace-layout/terminal-tab-types'
import {
  makeAgentEntry,
  makeManyTabState,
  LEAF_ID
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { createTabBarAgentProjectionSelector } from './tab-agent-types-by-tab-id'

// Same-agent pings change neither strip projection; a different agent must update the owning tab.
describe('tab bar agent projection identity contract', () => {
  it.each([20, 200])('retains projection identities through pings at %i tabs', (count) => {
    const tabs = makeManyTabState(count).tabsByWorktree!['wt-many']
    let statuses: Record<string, AgentStatusEntry> = Object.fromEntries(
      tabs.map((tab) => {
        const entry = makeAgentEntry(tab.id, 'working', 2_000_000_000, { agentType: 'claude' })
        return [entry.paneKey, entry]
      })
    )
    const layouts: Record<string, TerminalLayoutSnapshot> = Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
          },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        } satisfies TerminalLayoutSnapshot
      ])
    )
    const select = createTabBarAgentProjectionSelector()
    const baseline = select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })
    for (let ping = 1; ping <= 50; ping += 1) {
      statuses = Object.fromEntries(
        Object.entries(statuses).map(([key, entry]) => [
          key,
          { ...entry, updatedAt: 2_000_000_000 + ping }
        ])
      )
      const next = select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })
      expect(next.tabAgentTypesByTabId).toBe(baseline.tabAgentTypesByTabId)
      expect(next.nativeChatTabWideFallbackUnsafeTabsById).toBe(
        baseline.nativeChatTabWideFallbackUnsafeTabsById
      )
    }
    const changedKey = `term-5:${LEAF_ID}`
    statuses = { ...statuses, [changedKey]: { ...statuses[changedKey], agentType: 'codex' } }
    const changed = select({ agentStatusByPaneKey: statuses, terminalLayoutsByTabId: layouts })
    expect(changed.tabAgentTypesByTabId).not.toBe(baseline.tabAgentTypesByTabId)
    expect(changed.tabAgentTypesByTabId).toEqual({
      ...baseline.tabAgentTypesByTabId,
      'term-5': 'codex'
    })
    expect(changed.nativeChatTabWideFallbackUnsafeTabsById).toBe(
      baseline.nativeChatTabWideFallbackUnsafeTabsById
    )
  })
})
