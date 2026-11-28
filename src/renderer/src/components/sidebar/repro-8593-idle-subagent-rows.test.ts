/**
 * Issue #8593 — lingering idle subagent rows clutter the sidebar; clicking
 * them "does nothing" usefully (and they cannot be dismissed).
 *
 * Root cause (code-level):
 * 1. `buildSubagentChildRows` maps every parent `subagents[]` entry to a
 *    sidebar/dashboard child row, including `state: 'idle'`.
 * 2. Live hook updates keep idle children in the roster; only Claude *hydrate*
 *    prunes idle children (`dropHydratedIdleClaudeSubagents` in agent-hooks
 *    server) — so a long session that spawns tens of Task children piles up
 *    idle rows for the whole parent lifetime.
 * 3. Subagent rows set `hideDismiss` (DashboardAgentRow) so users cannot clear
 *    them; activation only focuses the parent pane (`activationPaneKey`),
 *    which looks like a no-op when the parent is already active.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/sidebar/repro-8593-idle-subagent-rows.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'

const serverSource = readFileSync(join(__dirname, '../../../../main/agent-hooks/server.ts'), 'utf8')
const dashboardRowSource = readFileSync(
  join(__dirname, '../dashboard/DashboardAgentRow.tsx'),
  'utf8'
)

function parentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'run cypress suite',
    updatedAt: 2000,
    stateStartedAt: 1000,
    agentType: 'claude',
    paneKey: 'tab-1:0',
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    stateHistory: [],
    subagents: [
      {
        id: 'cy-1',
        state: 'idle',
        startedAt: 1100,
        agentType: 'general-purpose',
        description: 'cypress: login'
      },
      {
        id: 'cy-2',
        state: 'idle',
        startedAt: 1200,
        agentType: 'general-purpose',
        description: 'cypress: checkout'
      },
      {
        id: 'cy-3',
        state: 'working',
        startedAt: 1300,
        agentType: 'general-purpose',
        description: 'cypress: pay'
      }
    ],
    ...overrides
  }
}

const tab = { id: 'tab-1', worktreeId: 'wt-1' } as TerminalTab

describe('#8593 lingering idle subagent child rows', () => {
  it('renders idle subagents as sidebar child rows (not filtered out)', () => {
    const rows = buildSubagentChildRows({
      parentEntry: parentEntry(),
      tab,
      parentIsFresh: true
    })
    expect(rows).toHaveLength(3)
    const idle = rows.filter((r) => r.state === 'idle')
    const working = rows.filter((r) => r.state === 'working')
    expect(idle).toHaveLength(2)
    expect(working).toHaveLength(1)
    // Accumulates every finished Task/subagent for the session.
    expect(idle.map((r) => r.entry.prompt)).toEqual(['cypress: login', 'cypress: checkout'])
  })

  it('activation only targets the parent pane (no independent surface)', () => {
    const rows = buildSubagentChildRows({
      parentEntry: parentEntry(),
      tab,
      parentIsFresh: true
    })
    for (const row of rows) {
      expect(row.activationPaneKey).toBe('tab-1:0')
      expect(row.tab.id).toBe('tab-1')
      // Synthetic key cannot be a real pane identity.
      expect(row.paneKey).toContain('\u0000subagent:')
    }
  })

  it('dashboard hides dismiss for subagent rows (cannot clear clutter)', () => {
    expect(dashboardRowSource).toMatch(/hideDismiss=\{agent\.rowSource === 'subagent'\}/)
  })

  it('only Claude hydrate prunes idle children — live path keeps them', () => {
    expect(serverSource).toMatch(/function dropHydratedIdleClaudeSubagents/)
    // Prune is applied only when hydrating last-status from disk, not on every
    // live status apply.
    expect(serverSource).toMatch(
      /const hydratedPayload = dropHydratedIdleClaudeSubagents\(entry\.payload\)/
    )
    // Live interrupt path deliberately keeps idle children as display state.
    expect(serverSource).toMatch(
      /idle children are display state[\s\S]{0,200}\.\.\.\(payload\.subagents \? \{ subagents: payload\.subagents/
    )
  })

  it('stale parent decays working children to idle (more clutter, not fewer)', () => {
    const rows = buildSubagentChildRows({
      parentEntry: parentEntry({
        subagents: [{ id: 'a1', state: 'working', startedAt: 1000 }]
      }),
      tab,
      parentIsFresh: false
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('idle')
  })
})
