// @vitest-environment happy-dom

// The switch, wired end to end in the renderer: a host that publishes its child records reaches the
// sidebar through the status bridge and the chat strip through the session channel, and both read
// one child the same way — including once the parent's transport is lost or its row goes stale.

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const holder: { store: TestStore | null } = { store: null }
  return {
    holder,
    subscribeStatus:
      vi.fn<
        (
          target: unknown,
          emit: (event: AgentSessionStatusEvent) => void
        ) => Promise<{ unsubscribe: () => void }>
      >(),
    unsubscribe: vi.fn()
  }
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.holder.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

vi.mock('@/components/sidebar/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownForPane: () => null
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { structuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { CompactAgentRow } from '@/components/sidebar/worktree-card-compact-agent-row'
import { buildSubagentChildRows } from '@/components/sidebar/worktree-subagent-child-rows'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

const MINUTE = 60_000
const tab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab
const PANE_KEY = structuredAgentSessionPaneKey(tab.id, tab.entityId)

function view(id: string, overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  const now = Date.now()
  return {
    id,
    providerId: `thread-${id}`,
    kind: 'agent',
    description: `Audit ${id}`,
    state: 'working',
    membership: 'live',
    firstObservedAt: now - 5 * MINUTE,
    observedAt: now - 2 * MINUTE,
    stoppable: false,
    invocation: { invocationId: `turn-${id}`, generation: 1 },
    ...overrides
  }
}

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: tab.entityId,
    workspaceId: tab.worktreeId,
    agent: 'codex',
    status: 'idle',
    hostExecutionOwned: true,
    latestPrompt: 'fan out',
    updatedAt: Date.now(),
    ...over
  }
}

function feed(): (event: AgentSessionStatusEvent) => void {
  const call = mocks.subscribeStatus.mock.calls[0]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return call[1]
}

function row(): AgentStatusEntry {
  const entry = mocks.holder.store?.getState().agentStatusByPaneKey[PANE_KEY]
  if (!entry) {
    throw new Error('no structured row')
  }
  return entry
}

type RenderedRow = { dot: string; lead: string; trail: string }

function readRow(root: Element, separator: string): RenderedRow {
  const [lead, trail] = [...(root.querySelector('span.truncate')?.children ?? [])].map(
    (span) => span.textContent ?? ''
  )
  return {
    dot: root.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '',
    lead: lead ?? '',
    trail: trail?.startsWith(separator) ? trail.slice(separator.length) : (trail ?? '')
  }
}

/** The sidebar's rows for the session, built exactly as the worktree card builds them. */
function sidebarRows(): RenderedRow[] {
  const entry = row()
  const terminalTab: TerminalTab = {
    id: tab.id,
    ptyId: null,
    worktreeId: tab.worktreeId,
    title: tab.label,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const parentIsFresh = isExplicitAgentStatusFresh(entry, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
  return buildSubagentChildRows({ parentEntry: entry, tab: terminalTab, parentIsFresh }).map(
    (agent) => {
      const container = document.createElement('div')
      container.innerHTML = renderToStaticMarkup(
        <TooltipProvider>
          <CompactAgentRow agent={agent} now={Date.now()} onActivate={() => {}} />
        </TooltipProvider>
      )
      return readRow(container, ' - ')
    }
  )
}

/** The strip's rows, from the real session-status component over the channel's roster. */
function stripRows(container: HTMLElement): RenderedRow[] {
  return [...container.querySelectorAll('[data-native-chat-background-tasks] li')]
    .filter((item) => item.querySelector(':scope > span.truncate'))
    .map((item) => readRow(item, ' · '))
}

function Surfaces(props: { roster: AgentSessionBackgroundTaskState }): React.JSX.Element {
  return (
    <TooltipProvider>
      <StructuredAgentSessionStatusBridge />
      <NativeChatStructuredSessionStatus
        sessionId={tab.entityId}
        agentLabel="Claude"
        startupPhase="ready"
        paneKey={PANE_KEY}
        error={null}
        composerError={null}
        isVisible
        backgroundTasks={structuredSessionBackgroundTasksView(props.roster, null)}
        stopBackgroundTask={async () => undefined}
      />
    </TooltipProvider>
  )
}

describe('the switch: both surfaces read the host child records', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.holder.store?.setState({
      agentStatusByPaneKey: {},
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': [tab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  async function mountWith(children: AgentChildWorkView[]) {
    // The summary and the channel carry the same views; the summary omits usage.
    const roster: AgentSessionBackgroundTaskState = {
      state: 'monitoring',
      supportsStopAll: false,
      children
    }
    const rendered = render(<Surfaces roster={roster} />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    act(() => feed()({ type: 'snapshot', sessions: [summary({ children })] }))
    const header = rendered.container.querySelector('[aria-expanded]')
    if (header) {
      fireEvent.click(header)
    }
    return rendered
  }

  it("copies the host's views onto the row and derives the legacy roster from them", async () => {
    const shell = view('shell', {
      kind: 'command',
      providerId: 'codex-command:thread:thread-a:cmd-1',
      description: 'npm run dev',
      state: 'monitoring',
      parentChildWorkId: 'a'
    })
    const finished = view('a', {
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: Date.now() - MINUTE,
      lastMessage: 'Parser is clean'
    })
    const running = view('b')
    await mountWith([finished, shell, running])
    expect(row().children).toEqual([finished, shell, running])
    // The legacy roster lists live agents only, under the id a Codex subagent's row always had.
    expect(row().subagents).toEqual([
      expect.objectContaining({ id: 'codex-agent:thread-b', state: 'working' })
    ])
    // An idle lead held open by a live subagent reads working, from the records.
    expect(row()).toMatchObject({ state: 'working' })
  })

  // The live-entry builder copies fields one by one; an unchanged list keeps its identity so the
  // rows derived from it do not re-render, and a changed one replaces it.
  it("keeps the row's child list when a summary repeats it, and replaces it when it changes", async () => {
    const children = [view('a')]
    await mountWith(children)
    const first = row().children
    act(() => feed()({ type: 'status', session: summary({ children: structuredClone(children) }) }))
    expect(row().children).toBe(first)
    act(() =>
      feed()({
        type: 'status',
        session: summary({ children: [{ ...children[0]!, lastMessage: 'Found 3 call sites' }] })
      })
    )
    expect(row().children).not.toBe(first)
    expect(row().children?.[0]?.lastMessage).toBe('Found 3 call sites')
  })

  it('shows one child the same way on both surfaces, live, lost, and stale', async () => {
    const children = [
      view('a', {
        operation: { toolName: 'Bash', input: 'npm test', basis: 'open', observedAt: Date.now() }
      })
    ]
    const { container } = await mountWith(children)
    const live = { dot: 'Working', lead: 'Audit a', trail: 'Bash: npm test' }
    expect(sidebarRows()).toEqual([live])
    expect(stripRows(container)).toEqual([live])

    // The status stream drops: the host is not heard from, so neither surface vouches for it.
    act(() => feed()({ type: 'end' }))
    const lost = { dot: 'No recent update', lead: 'Audit a', trail: 'No update in 2m' }
    await waitFor(() => expect(sidebarRows()).toEqual([lost]))
    expect(stripRows(container)).toEqual([lost])
  })

  it('reads a stale parent row the same way on both surfaces', async () => {
    const { container } = await mountWith([view('a')])
    // The host no longer owns the session, and its last word is older than the freshness window.
    act(() =>
      feed()({
        type: 'status',
        session: summary({
          hostExecutionOwned: undefined,
          status: 'working',
          updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - MINUTE,
          children: [view('a')]
        })
      })
    )
    await waitFor(() =>
      expect(isExplicitAgentStatusFresh(row(), Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(false)
    )
    const stale = { dot: 'No recent update', lead: 'Audit a', trail: 'No update in 2m' }
    expect(sidebarRows()).toEqual([stale])
    expect(stripRows(container)).toEqual([stale])
  })
})
