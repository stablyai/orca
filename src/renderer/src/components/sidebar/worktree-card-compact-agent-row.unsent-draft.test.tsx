/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

const mocks = vi.hoisted(() => ({ unsent: true }))

vi.mock('@/lib/agent-unsent-draft', () => ({
  useAgentUnsentDraft: () => mocks.unsent,
  scheduleAgentUnsentDraftCheck: () => {},
  registerAgentUnsentDraftProbe: () => () => {}
}))

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

function makeAgent(): DashboardAgentRowData {
  const paneKey = 'tab-1:leaf-1'
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const entry: AgentStatusEntry = {
    state: 'done',
    prompt: 'Revisar o prompt do board',
    updatedAt: 60_000,
    stateStartedAt: 60_000,
    agentType: 'claude',
    paneKey,
    stateHistory: []
  }
  return { paneKey, entry, tab, agentType: 'claude', state: entry.state, startedAt: 60_000 }
}

function render(sendTargetStatus?: 'eligible'): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(
    <TooltipProvider>
      <CompactAgentRow
        agent={makeAgent()}
        now={120_000}
        onActivate={vi.fn()}
        sendTargetStatus={sendTargetStatus}
      />
    </TooltipProvider>
  )
  return host
}

describe('CompactAgentRow unsent-draft marker', () => {
  it('marks a session holding a message the user has not sent', () => {
    mocks.unsent = true
    const host = render()
    const marker = host.querySelector('[data-agent-unsent-draft]')

    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('aria-label')).toBe('Message typed but not sent')
    // The row's whole point is that it no longer explains itself through a native tooltip.
    expect(marker?.hasAttribute('title')).toBe(false)
  })

  it('stays out of the row when nothing is waiting to be sent', () => {
    mocks.unsent = false

    expect(render().querySelector('[data-agent-unsent-draft]')).toBeNull()
  })

  it('stays out of send-target mode, where the row is a picker', () => {
    mocks.unsent = true

    expect(render('eligible').querySelector('[data-agent-unsent-draft]')).toBeNull()
  })
})
