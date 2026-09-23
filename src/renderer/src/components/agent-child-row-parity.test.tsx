/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import DashboardAgentRow from '@/components/dashboard/DashboardAgentRow'
import { NativeChatBackgroundTasksStatus } from '@/components/native-chat/NativeChatBackgroundTasksStatus'
import { CompactAgentRow } from '@/components/sidebar/worktree-card-compact-agent-row'
import { buildSubagentChildRows } from '@/components/sidebar/worktree-subagent-child-rows'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/dashboard/use-agent-row-conversation-name', () => ({
  useAgentRowConversationName: () => null
}))

vi.mock('@/components/sidebar/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

const NOW = 1_000_000
const MINUTE = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

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

function view(id: string, overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id,
    providerId: `task-${id}`,
    kind: 'agent',
    description: 'Audit the parser',
    agentType: 'general-purpose',
    state: 'working',
    membership: 'live',
    firstObservedAt: NOW - 5 * MINUTE,
    observedAt: NOW - 2 * MINUTE,
    stoppable: true,
    invocation: { invocationId: `spawn-${id}`, generation: 1 },
    ...overrides
  }
}

function settled(
  outcome: NonNullable<AgentChildWorkView['outcome']>,
  overrides: Partial<AgentChildWorkView> = {}
): AgentChildWorkView {
  return view('child', {
    state: 'done',
    membership: 'settled',
    outcome,
    settledAt: NOW - 3 * MINUTE,
    ...overrides
  })
}

const OWNED_SHELL = view('shell', {
  kind: 'command',
  description: 'npm run dev',
  agentType: undefined,
  state: 'monitoring',
  parentChildWorkId: 'child'
})

function parentWith(children: AgentChildWorkView[], updatedAt = NOW): AgentStatusEntry {
  return {
    paneKey: 'parent-tab:leaf-1',
    tabId: tab.id,
    worktreeId: tab.worktreeId,
    state: 'done',
    prompt: 'parent prompt',
    updatedAt,
    stateStartedAt: NOW - 20 * MINUTE,
    stateHistory: [],
    children
  }
}

type RenderedRow = { dot: string; lead: string; trail: string }

function readRow(root: Element, separator: string): RenderedRow {
  const text = root.querySelector('span.truncate')
  const [lead, trail] = [...(text?.children ?? [])].map((span) => span.textContent ?? '')
  return {
    dot: root.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '',
    lead: lead ?? '',
    trail: trail?.startsWith(separator) ? trail.slice(separator.length) : (trail ?? '')
  }
}

function mount(markup: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = markup
  return container
}

function sidebarRows(parent: AgentStatusEntry, parentIsFresh = true): RenderedRow[] {
  return buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh }).map((agent) =>
    readRow(
      mount(
        renderToStaticMarkup(
          <TooltipProvider>
            <CompactAgentRow agent={agent} now={NOW} onActivate={() => {}} />
          </TooltipProvider>
        )
      ),
      ' - '
    )
  )
}

function stripRows(children: AgentChildWorkView[]): RenderedRow[] {
  const root = mount(
    renderToStaticMarkup(
      <NativeChatBackgroundTasksStatus
        tasks={[]}
        settledTasks={[]}
        childViews={children}
        supportsTaskStop
        supportsStopAll
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        indicatorActive
        isVisible
        expanded
        onExpandedChange={() => {}}
        onStop={() => {}}
      />
    )
  )
  return [...root.querySelectorAll('li')]
    .filter((row) => row.querySelector(':scope > span.truncate'))
    .map((row) => readRow(row, ' · '))
}

const SCENARIOS: [string, AgentChildWorkView[], RenderedRow][] = [
  [
    'working, no known operation',
    [view('child')],
    { dot: 'Working', lead: 'Audit the parser', trail: 'general-purpose' }
  ],
  [
    'working with a tool',
    [
      view('child', {
        operation: { toolName: 'Read', input: 'src/parser.ts', basis: 'open', observedAt: NOW }
      })
    ],
    { dot: 'Working', lead: 'Audit the parser', trail: 'Read: src/parser.ts' }
  ],
  [
    'running a shell in the foreground',
    [
      view('child', {
        operation: { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: NOW }
      })
    ],
    { dot: 'Working', lead: 'Audit the parser', trail: 'Bash: npm test' }
  ],
  [
    'finished, while a shell it launched still runs',
    [settled('succeeded', { lastMessage: 'All green' }), OWNED_SHELL],
    {
      dot: 'Monitoring background tasks',
      lead: 'Monitoring background tasks',
      trail: 'Audit the parser'
    }
  ],
  [
    'waiting on an approval',
    [
      view('child', {
        state: 'waiting',
        operation: { toolName: 'Edit', input: 'src/parser.ts', basis: 'open', observedAt: NOW }
      })
    ],
    { dot: 'Waiting for input', lead: 'Audit the parser', trail: 'Edit: src/parser.ts' }
  ],
  [
    'blocked',
    [view('child', { state: 'blocked', lastMessage: 'Rate limited, retrying' })],
    { dot: 'Blocked', lead: 'Audit the parser', trail: 'Rate limited, retrying' }
  ],
  [
    'finished',
    [settled('succeeded', { lastMessage: 'Found 3 call sites' })],
    { dot: 'Done', lead: 'Audit the parser', trail: 'Found 3 call sites' }
  ],
  [
    'failed',
    [settled('failed', { lastMessage: 'Exit code 1' })],
    { dot: 'Failed', lead: 'Audit the parser', trail: 'Exit code 1' }
  ],
  [
    'cancelled',
    [settled('cancelled')],
    { dot: 'Interrupted', lead: 'Audit the parser', trail: 'general-purpose' }
  ],
  [
    'ended, outcome unknown',
    [settled('unknown')],
    { dot: 'Idle', lead: 'Audit the parser', trail: 'Ended' }
  ],
  [
    'unverifiable',
    [view('child', { state: 'unverifiable' })],
    { dot: 'No recent update', lead: 'Audit the parser', trail: 'No update in 2m' }
  ]
]

describe('a child reads the same in the sidebar and the chat strip', () => {
  it.each(SCENARIOS)('%s', (_name, children, expected) => {
    const [sidebar] = sidebarRows(parentWith(children))
    const [strip] = stripRows(children)
    expect(sidebar).toEqual(expected)
    expect(strip).toEqual(expected)
  })

  it('shows the monitoring icon on the full sidebar row too', () => {
    const [agent] = buildSubagentChildRows({
      parentEntry: parentWith([settled('succeeded'), OWNED_SHELL]),
      tab,
      parentIsFresh: true
    })
    const root = mount(
      renderToStaticMarkup(
        <TooltipProvider>
          <DashboardAgentRow
            agent={agent}
            now={NOW}
            onActivate={() => {}}
            onDismiss={() => {}}
            stateDotSize="sm"
            hideExpand
          />
        </TooltipProvider>
      )
    )
    expect(root.querySelector('[aria-label]')?.getAttribute('aria-label')).toBe(
      'Monitoring background tasks'
    )
    // The finished child's last tool line is stale; neither row names it.
    expect(root.textContent).not.toContain('Bash')
  })

  it('never shows a monitoring child tool text on either surface', () => {
    const children = [
      settled('succeeded', { lastMessage: 'Bash: npm test finished' }),
      { ...OWNED_SHELL, description: 'tail -f server.log' }
    ]
    const [sidebar] = sidebarRows(parentWith(children))
    const [strip] = stripRows(children)
    for (const row of [sidebar, strip]) {
      expect(row.dot).toBe('Monitoring background tasks')
      expect(`${row.lead} ${row.trail}`).not.toContain('npm test')
    }
  })
})

describe('sibling child rows keep their own clocks', () => {
  it('reads each sibling from its own evidence, not the parent clock', () => {
    const parent = parentWith(
      [
        view('busy', { description: 'Busy child', observedAt: NOW - 30_000 }),
        view('quiet', {
          description: 'Quiet child',
          firstObservedAt: NOW - 15 * MINUTE,
          observedAt: NOW - 10 * MINUTE
        })
      ],
      NOW - 40 * MINUTE
    )
    const rows = buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh: false })
    expect(rows.map((row) => row.entry.evidenceObservedAt)).toEqual([
      NOW - 30_000,
      NOW - 10 * MINUTE
    ])
    expect(rows.map((row) => row.startedAt)).toEqual([NOW - 5 * MINUTE, NOW - 15 * MINUTE])
    expect(sidebarRows(parent, false).map((row) => row.trail)).toEqual([
      'No update in 0m',
      'No update in 10m'
    ])
  })

  it('times a settled child from when it ended', () => {
    const [agent] = buildSubagentChildRows({
      parentEntry: parentWith([settled('succeeded')]),
      tab,
      parentIsFresh: true
    })
    const text = mount(
      renderToStaticMarkup(
        <TooltipProvider>
          <CompactAgentRow agent={agent} now={NOW} onActivate={() => {}} />
        </TooltipProvider>
      )
    ).textContent
    expect(text?.endsWith('3m')).toBe(true)
    const strip = mount(
      renderToStaticMarkup(
        <NativeChatBackgroundTasksStatus
          tasks={[]}
          settledTasks={[]}
          childViews={[settled('succeeded')]}
          supportsTaskStop
          supportsStopAll
          stoppingTaskIds={new Set()}
          stoppingAll={false}
          indicatorActive
          isVisible
          expanded
          onExpandedChange={() => {}}
          onStop={() => {}}
        />
      )
    )
    expect(strip.querySelector('li')?.textContent).toContain('ended 3m 0s ago')
  })
})

describe('the chat strip from views', () => {
  it('nests a child-owned shell under its owner and stops by the provider id', () => {
    const children = [
      view('child', { description: 'Dev server owner' }),
      view('shell', {
        kind: 'command',
        description: 'npm run dev',
        agentType: undefined,
        state: 'monitoring',
        parentChildWorkId: 'child'
      }),
      view('main-shell', {
        kind: 'command',
        description: 'tail -f log',
        agentType: undefined,
        state: 'monitoring'
      })
    ]
    const root = mount(
      renderToStaticMarkup(
        <NativeChatBackgroundTasksStatus
          tasks={[]}
          settledTasks={[]}
          childViews={children}
          supportsTaskStop
          supportsStopAll
          stoppingTaskIds={new Set(['task-shell'])}
          stoppingAll={false}
          indicatorActive
          isVisible
          expanded
          onExpandedChange={() => {}}
          onStop={() => {}}
        />
      )
    )
    const groups = [...root.querySelectorAll('ul[aria-label]')].map((list) =>
      list.getAttribute('aria-label')
    )
    expect(groups).toEqual(['Agents', 'Shell'])
    const nested = root.querySelector('ul[aria-label="Agents"] ul')
    expect(nested?.textContent).toContain('npm run dev')
    expect(root.querySelector('ul[aria-label="Shell"]')?.textContent).not.toContain('npm run dev')
    const stopShell = root.querySelector('button[aria-label="Stop npm run dev"]')
    expect(stopShell?.hasAttribute('disabled')).toBe(true)
  })
})
