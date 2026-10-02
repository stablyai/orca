/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type { AgentStatusEntry, AgentSubagentSnapshot } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { NativeChatBackgroundTasksStatus } from '@/components/native-chat/NativeChatBackgroundTasksStatus'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CompactAgentRow } from './worktree-card-compact-agent-row'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

// Captured on the unmodified renderer: a host that sends only today's legacy shapes (an old host,
// or any CLI pane) must keep rendering exactly these rows.

const NOW = 1_000_000

const tab: TerminalTab = {
  id: 'parent-tab',
  ptyId: null,
  worktreeId: 'wt-1',
  title: 'Parent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function parentWith(
  subagents: AgentSubagentSnapshot[],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey: 'parent-tab:leaf-1',
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    state: 'working',
    prompt: 'parent prompt',
    updatedAt: 700_000,
    stateStartedAt: 10,
    stateHistory: [],
    subagents,
    ...overrides
  }
}

const SUBAGENTS: AgentSubagentSnapshot[] = [
  {
    id: 'described',
    state: 'working',
    startedAt: 400_000,
    agentType: 'general-purpose',
    model: 'claude-sonnet',
    description: 'Review the parser'
  },
  { id: 'typed-only', state: 'working', startedAt: 500_000, agentType: 'Explore' },
  { id: 'anonymous', state: 'working', startedAt: 0 },
  { id: 'asking', state: 'waiting', startedAt: 600_000, description: 'Approve edits' },
  { id: 'stuck', state: 'blocked', startedAt: 610_000, description: 'Rate limited' },
  { id: 'parked', state: 'idle', startedAt: 620_000, description: 'Teammate', agentType: 'writer' },
  { id: 'quiet', state: 'unverifiable', startedAt: 630_000, description: 'Lost child' }
]

function normalize(markup: string): string {
  return markup.replaceAll('<!-- -->', '')
}

function compactMarkup(parent: AgentStatusEntry, parentIsFresh: boolean): string[] {
  return buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh }).map((agent) =>
    normalize(
      renderToStaticMarkup(
        <TooltipProvider>
          <CompactAgentRow agent={agent} now={NOW} onActivate={() => {}} />
        </TooltipProvider>
      )
    )
  )
}

function fullMarkup(parent: AgentStatusEntry, parentIsFresh: boolean): string[] {
  return buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh }).map((agent) =>
    normalize(
      renderToStaticMarkup(
        <TooltipProvider>
          <DashboardAgentRow
            agent={agent}
            now={NOW}
            onActivate={() => {}}
            onDismiss={() => {}}
            stateDotSize="sm"
            hideExpand
            hideLineageConnectors
          />
        </TooltipProvider>
      )
    )
  )
}

function textOf(markup: string): string {
  const container = document.createElement('div')
  container.innerHTML = markup
  return container.textContent ?? ''
}

describe('sidebar child rows from a legacy subagents snapshot', () => {
  it('render the compact rows exactly as before', () => {
    const rows = compactMarkup(parentWith(SUBAGENTS), true)
    expect(rows.map(textOf)).toEqual([
      'Review the parser - general-purposeclaude-sonnet10m',
      'Explore8m',
      'Working - Agent16m',
      'Approve edits - Agent6m',
      'Rate limited - Agent6m',
      'Teammate - writer6m',
      'Lost child - No update in 5m6m'
    ])
    expect(rows).toMatchSnapshot()
  })

  it('render a stale parent and a lost transport exactly as before', () => {
    const stale = compactMarkup(parentWith(SUBAGENTS.slice(0, 4)), false)
    const lost = compactMarkup(
      parentWith(SUBAGENTS.slice(0, 1), { subagentObservation: 'unverifiable' }),
      true
    )
    expect([...stale, ...lost].map(textOf)).toEqual([
      'Review the parser - No update in 5mclaude-sonnet10m',
      'Explore - No update in 5m8m',
      'No recent update - No update in 5m16m',
      'Approve edits - No update in 5m6m',
      'Review the parser - No update in 5mclaude-sonnet10m'
    ])
    expect([...stale, ...lost]).toMatchSnapshot()
  })

  it('render the full rows exactly as before', () => {
    expect(fullMarkup(parentWith(SUBAGENTS), true)).toMatchSnapshot()
    expect(fullMarkup(parentWith(SUBAGENTS.slice(0, 2)), false)).toMatchSnapshot()
  })
})

const TASKS: AgentSessionBackgroundTask[] = [
  {
    id: 'agent-working',
    kind: 'agent',
    description: 'Review the parser',
    name: 'general-purpose',
    state: 'working',
    startedAt: 400_000,
    totalTokens: 18_200
  },
  { id: 'agent-waiting', kind: 'agent', description: 'Approve edits', state: 'waiting' },
  { id: 'agent-blocked', kind: 'agent', name: 'Explore', state: 'blocked', startedAt: 500_000 },
  { id: 'agent-quiet', kind: 'agent', description: 'subagent', state: 'unverifiable' },
  { id: 'agent-stateless', kind: 'agent', description: 'Old host child', startedAt: 600_000 },
  {
    id: 'command-1',
    kind: 'command',
    description: 'npm run dev',
    startedAt: 300_000,
    stoppable: false
  },
  { id: 'monitor-1', kind: 'monitor', description: 'tail -f server.log' }
]

const SETTLED_TASKS: AgentSessionBackgroundTask[] = [
  {
    id: 'agent-done',
    kind: 'agent',
    description: 'Summarize logs',
    state: 'done',
    startedAt: 100_000,
    totalTokens: 900
  },
  { id: 'agent-stopped', kind: 'agent', description: 'Cancelled child', state: 'idle' },
  { id: 'agent-failed', kind: 'agent', description: 'Failed child', state: 'blocked' }
]

function stripMarkup(supportsTaskStop: boolean): string {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  try {
    return normalize(
      renderToStaticMarkup(
        <TooltipProvider>
          <NativeChatBackgroundTasksStatus
            tasks={TASKS}
            settledTasks={SETTLED_TASKS}
            supportsTaskStop={supportsTaskStop}
            supportsStopAll
            stoppingTaskIds={new Set(['agent-working'])}
            stoppingAll={false}
            indicatorActive
            isVisible
            expanded
            onExpandedChange={() => {}}
            onStop={() => {}}
          />
        </TooltipProvider>
      )
    )
  } finally {
    vi.useRealTimers()
  }
}

describe('chat strip rows from a legacy background-task roster', () => {
  it('render exactly as before', () => {
    const markup = stripMarkup(true)
    const container = document.createElement('div')
    container.innerHTML = markup
    expect([...container.querySelectorAll('li')].map((row) => row.textContent)).toEqual([
      'Failed child · failed',
      'Background agent · no contactStop',
      'Cancelled child',
      'Approve edits · needs approvalStop',
      'Summarize logs900',
      'Review the parser18.2k · 10m 0sStop',
      'Explore · failed8m 20sStop',
      'Old host child6m 40sStop',
      'npm run dev11m 40s',
      'tail -f server.logStop'
    ])
    expect(markup).toMatchSnapshot()
    expect(stripMarkup(false)).toMatchSnapshot()
  })
})
