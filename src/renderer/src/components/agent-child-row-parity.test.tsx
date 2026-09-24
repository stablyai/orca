/** @vitest-environment happy-dom */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentChildRowContextForParent,
  type AgentChildRowContext
} from '../../../shared/agent-child-row-model'
import type { AgentSessionBackgroundTask } from '../../../shared/agent-session-wire'
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

function stripRows(
  children: AgentChildWorkView[] | undefined,
  childRowContext?: AgentChildRowContext,
  tasks: AgentSessionBackgroundTask[] = []
): RenderedRow[] {
  const root = mount(
    renderToStaticMarkup(
      <NativeChatBackgroundTasksStatus
        tasks={tasks}
        settledTasks={[]}
        childViews={children}
        childRowContext={childRowContext}
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

/** The full sidebar row: every dot label it carries, and its whole text. */
function fullRow(parent: AgentStatusEntry): { labels: string[]; text: string } {
  const [agent] = buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh: true })
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
  return {
    labels: [...root.querySelectorAll('[aria-label]')].map(
      (element) => element.getAttribute('aria-label') ?? ''
    ),
    text: root.textContent ?? ''
  }
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
  ],
  [
    'parked, still live',
    [view('child', { state: 'idle' })],
    { dot: 'Idle', lead: 'Audit the parser', trail: 'general-purpose' }
  ]
]

/** What the full sidebar row, the CLI row's own layout, shows of the same detail. */
const FULL_ROW_DETAIL: Record<string, { shows: string[]; hides?: string[] }> = {
  'working, no known operation': { shows: [] },
  'working with a tool': { shows: ['Read', 'src/parser.ts'] },
  'running a shell in the foreground': { shows: ['Bash', 'npm test'] },
  'finished, while a shell it launched still runs': { shows: [], hides: ['All green'] },
  'waiting on an approval': { shows: ['Edit', 'src/parser.ts'] },
  blocked: { shows: ['Rate limited, retrying'] },
  finished: { shows: ['Found 3 call sites'] },
  failed: { shows: ['Exit code 1'] },
  cancelled: { shows: [] },
  'ended, outcome unknown': { shows: ['Ended'] },
  unverifiable: { shows: ['No update in 2m'] },
  'parked, still live': { shows: [] }
}

describe('a child reads the same in the sidebar and the chat strip', () => {
  it.each(SCENARIOS)('%s', (name, children, expected) => {
    const [sidebar] = sidebarRows(parentWith(children))
    const [strip] = stripRows(children)
    expect(sidebar).toEqual(expected)
    expect(strip).toEqual(expected)
    const full = fullRow(parentWith(children))
    expect(full.labels).toContain(expected.dot)
    expect(full.text).toContain(expected.lead === expected.dot ? expected.trail : expected.lead)
    for (const text of FULL_ROW_DETAIL[name].shows) {
      expect(full.text).toContain(text)
    }
    for (const text of FULL_ROW_DETAIL[name].hides ?? []) {
      expect(full.text).not.toContain(text)
    }
  })

  it('names an unlabeled child by the same state on every surface', () => {
    const children = [
      settled('failed', { description: undefined, agentType: undefined, lastMessage: 'Exit 2' })
    ]
    const [sidebar] = sidebarRows(parentWith(children))
    const [strip] = stripRows(children)
    expect(sidebar.lead).toBe('Failed')
    expect(strip.lead).toBe('Failed')
    expect(fullRow(parentWith(children)).text).toContain('Failed')
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

describe('one child reads the same from every shape a host publishes', () => {
  it('names and details it identically from views, the subagents snapshot and the task roster', () => {
    // A placeholder description falls through to the child's real label on every path.
    const children = [view('child', { description: 'task', agentType: 'Explore' })]
    const snapshotParent: AgentStatusEntry = {
      ...parentWith([]),
      children: undefined,
      subagents: [
        {
          id: 'child',
          state: 'working',
          startedAt: NOW - 5 * MINUTE,
          description: 'task',
          agentType: 'Explore'
        }
      ]
    }
    const roster: AgentSessionBackgroundTask[] = [
      { id: 'child', kind: 'agent', description: 'task', name: 'Explore', state: 'working' }
    ]
    const expected: RenderedRow = { dot: 'Working', lead: 'Explore', trail: '' }
    expect(sidebarRows(parentWith(children))).toEqual([expected])
    expect(sidebarRows(snapshotParent)).toEqual([expected])
    expect(stripRows(children)).toEqual([expected])
    expect(stripRows(undefined, undefined, roster)).toEqual([expected])
  })
})

describe('a mirrored parent and its children read one silence', () => {
  const SKEW = 20 * MINUTE
  // The host's clock runs 20 minutes ahead; this machine received its last word 3 minutes ago.
  function mirroredParent(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
    return {
      ...parentWith([]),
      state: 'working',
      updatedAt: NOW - 3 * MINUTE + SKEW,
      mirroredEvidenceReceivedAt: NOW - 3 * MINUTE,
      ...overrides
    }
  }

  it('times a snapshot child on the receipt clock the parent decays on', () => {
    const parent = mirroredParent({
      children: undefined,
      subagents: [
        { id: 'child', state: 'working', startedAt: NOW - 9 * MINUTE, description: 'Audit' }
      ]
    })
    expect(sidebarRows(parent, false)[0].trail).toBe('No update in 3m')
  })

  it('times a view child by its own host-clock age, never across machines', () => {
    const children = [view('child', { observedAt: NOW - 5 * MINUTE + SKEW })]
    const parent = mirroredParent({ children })
    expect(sidebarRows(parent, false)[0].trail).toBe('No update in 5m')
    expect(stripRows(children, agentChildRowContextForParent(parent, false))[0].trail).toBe(
      'No update in 5m'
    )
    const [agent] = buildSubagentChildRows({ parentEntry: parent, tab, parentIsFresh: false })
    const full = mount(
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
    expect(full.textContent).toContain('No update in 5m')
  })
})

describe('a lost or stale parent reads the same on both surfaces', () => {
  const children = [
    view('child', {
      operation: { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: NOW }
    })
  ]
  const lost: RenderedRow = {
    dot: 'No recent update',
    lead: 'Audit the parser',
    trail: 'No update in 2m'
  }

  it('when the transport to the host is lost', () => {
    const parent = { ...parentWith(children), subagentObservation: 'unverifiable' as const }
    const [sidebar] = sidebarRows(parent)
    const [strip] = stripRows(children, agentChildRowContextForParent(parent, true))
    expect(sidebar).toEqual(lost)
    expect(strip).toEqual(lost)
  })

  it('when the parent row has gone stale', () => {
    const parent = parentWith([settled('succeeded'), OWNED_SHELL], NOW - 40 * MINUTE)
    const [sidebar] = sidebarRows(parent, false)
    const [strip] = stripRows(parent.children ?? [], agentChildRowContextForParent(parent, false))
    const stale = { dot: 'No recent update', lead: 'Audit the parser', trail: 'No update in 2m' }
    expect(sidebar).toEqual(stale)
    expect(strip).toEqual(stale)
  })

  it('without a context the strip reports what the host last said', () => {
    expect(stripRows(children)[0].dot).toBe('Working')
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

  it('times a settled child from when it ended in the sidebar, and freezes its run in the strip', () => {
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
    // Ran from 5m ago until it settled 3m ago; a finished row never ticks.
    expect(strip.querySelector('li')?.textContent).toMatch(/2m 0s$/)
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
