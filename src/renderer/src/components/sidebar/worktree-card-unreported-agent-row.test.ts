import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { dashboardRowBucketProjection } from '@/components/dashboard/dashboard-row-bucket'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { summarizeAgents } from './worktree-card-agent-summary'

const LEAF_ID = '77777777-7777-4777-8777-777777777777'

function makeTab(id: string): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// Hand-built titles: the sidebar row for a pane whose title is `title` and that has no hook row.
function titleRow(title: string, tabId = 'tab-1') {
  const [row] = buildWorktreeAgentRows({
    tabs: [makeTab(tabId)],
    entries: [],
    retained: [],
    runtimePaneTitlesByTabId: { [tabId]: { 1: title } },
    ptyIdsByTabId: { [tabId]: [`pty-${tabId}`] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    now: 2000
  })
  expect(row).toBeDefined()
  return row
}

describe('a sidebar row whose title only names the agent', () => {
  it('reads "No status reported" beside a muted dashed ring, not Idle', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(CompactAgentRow, { agent: titleRow('agy'), now: 2000, onActivate: vi.fn() })
      )
    )

    expect(markup).toContain('No status reported')
    expect(markup).toContain('aria-label="No status reported"')
    expect(markup).toContain('lucide-circle-dashed')
    expect(markup).toContain('text-muted-foreground')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('>Idle<')
  })

  it('names the state with the same phrase in the worktree summary, ranked just above idle', () => {
    const unreported = titleRow('grok', 'tab-1')
    const idle = titleRow('agy ready', 'tab-2')

    expect(summarizeAgents([idle, unreported], 'Agents')).toBe(
      'Agents: 1 no status reported, 1 idle'
    )
  })

  it('publishes idle to the dashboard card, whose validator drops unknown states', () => {
    const unreported = dashboardRowBucketProjection(titleRow('aider'))
    const idle = dashboardRowBucketProjection(titleRow('aider ready'))

    expect(unreported.dotState).toBe('idle')
    expect(unreported).toEqual(idle)
  })
})
