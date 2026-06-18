import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { ReviewNotesSendMenuContent } from './ReviewNotesSendMenuContent'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const TAB_A = 'tab-a'
const TAB_B = 'tab-b'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

const hookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  cleanups: [] as (() => void)[]
}))

const harness = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  worktreeAgentRows: [] as DashboardAgentRowData[],
  noteTargets: [] as {
    paneKey: string
    tabId: string
    leafId: string
    agentType: TuiAgent
    tabTitle: string
    status: 'eligible' | 'disabled'
    disabledReason?: string
  }[],
  now: 600_000
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
    useEffect(effect: () => void | (() => void)): void {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        hookRuntime.cleanups.push(cleanup)
      }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = hookRuntime.index++
      if (!(stateIndex in hookRuntime.states)) {
        hookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        hookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(hookRuntime.states[stateIndex] as T)
            : next
      }
      return [hookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(harness.storeState)
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (status: string) => status,
  sendNotesToActiveAgentSession: harness.sendNotesToActiveAgentSession
}))

vi.mock('@/lib/notes-send-agent-targets', () => ({
  deriveNotesSendAgentTargets: () => harness.noteTargets
}))

vi.mock('@/lib/telemetry', () => ({
  track: harness.track
}))

vi.mock('@/components/dashboard/useNow', () => ({
  useNow: () => harness.now
}))

vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => harness.worktreeAgentRows
}))

vi.mock('@/components/AgentStateDot', () => ({
  AgentStateDot: function AgentStateDot(props: Record<string, unknown>) {
    return { type: 'AgentStateDot', props }
  },
  agentStateLabel: (state: string) => {
    switch (state) {
      case 'working':
        return 'Working'
      case 'blocked':
        return 'Blocked'
      case 'waiting':
        return 'Waiting for input'
      case 'done':
        return 'Done'
      case 'idle':
        return 'Idle'
      default:
        return state
    }
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: function AgentIcon(props: Record<string, unknown>) {
    return { type: 'AgentIcon', props }
  }
}))

vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: function QuickLaunchAgentMenuItems(props: Record<string, unknown>) {
    return { type: 'QuickLaunchAgentMenuItems', props }
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: function DropdownMenuItem(props: Record<string, unknown>) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuLabel: function DropdownMenuLabel(props: Record<string, unknown>) {
    return { type: 'DropdownMenuLabel', props }
  },
  DropdownMenuSeparator: function DropdownMenuSeparator(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSeparator', props }
  }
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    message: vi.fn(),
    success: vi.fn()
  }
}))

function agentEntry(
  paneKey: string,
  agentType: TuiAgent,
  state: AgentStatusState = 'done',
  stateStartedAt = harness.now
): AgentStatusEntry {
  return {
    paneKey,
    state,
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    agentType,
    stateHistory: []
  }
}

function agentRow({
  paneKey,
  tabId,
  title,
  agentType,
  state = 'done',
  startedAt = harness.now
}: {
  paneKey: string
  tabId: string
  title: string
  agentType: TuiAgent
  state?: AgentStatusState | 'idle'
  startedAt?: number
}): DashboardAgentRowData {
  const entryState: AgentStatusState = state === 'idle' ? 'working' : state
  return {
    paneKey,
    entry: agentEntry(paneKey, agentType, entryState, startedAt),
    tab: tab(tabId, { title }) as DashboardAgentRowData['tab'],
    agentType,
    state,
    startedAt
  }
}

function tab(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function leafLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function setStore(overrides: Record<string, unknown> = {}): void {
  harness.storeState = {
    activeWorktreeId: 'wt-1',
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    tabsByWorktree: { 'wt-1': [] },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ...overrides
  }
}

function expand(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map((entry) => expand(entry))
  }
  if (!React.isValidElement(node)) {
    if (typeof node === 'object' && 'props' in node) {
      const element = node as ReactElementLike
      return { ...element, props: { ...element.props, children: expand(element.props.children) } }
    }
    return node
  }
  const element = node as React.ReactElement<Record<string, unknown>>
  if (typeof element.type === 'function') {
    const Component = element.type as (props: Record<string, unknown>) => unknown
    return expand(Component(element.props))
  }
  return {
    type: element.type,
    props: { ...element.props, children: expand(element.props.children) }
  }
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findAllByType(node: unknown, type: unknown): ReactElementLike[] {
  const found: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === type) {
      found.push(entry)
    }
  })
  return found
}

function findByType(node: unknown, type: unknown): ReactElementLike {
  const found = findAllByType(node, type)[0]
  if (!found) {
    throw new Error(`element not found: ${String(type)}`)
  }
  return found
}

function collectText(node: unknown): string {
  if (node == null || typeof node === 'boolean') {
    return ''
  }
  if (typeof node === 'string') {
    return node
  }
  if (typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
}

function render(props: Record<string, unknown> = {}): unknown {
  hookRuntime.index = 0
  return expand(
    <ReviewNotesSendMenuContent worktreeId="wt-1" groupId="group-1" prompt="my notes" {...props} />
  )
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ReviewNotesSendMenuContent', () => {
  beforeEach(() => {
    hookRuntime.states = []
    hookRuntime.index = 0
    hookRuntime.cleanups = []
    harness.sendNotesToActiveAgentSession.mockReset()
    harness.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
    harness.track.mockReset()
    harness.worktreeAgentRows = []
    harness.noteTargets = []
    harness.now = 600_000
    setStore()
  })

  it('enumerates each running agent of the worktree as a send target', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: {
        'wt-1': [
          tab(TAB_A, { title: 'Terminal 1' }),
          tab(TAB_B, { title: 'Codex', launchAgent: 'codex' })
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      },
      {
        paneKey: makePaneKey(TAB_B, LEAF_B),
        tabId: TAB_B,
        leafId: LEAF_B,
        agentType: 'codex',
        tabTitle: 'Codex',
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.props.disabled === false)).toBe(true)
    expect(collectText(items[0])).toContain('Claude')
    expect(collectText(items[1])).toContain('Codex')
  })

  it('orders send targets by the current worktree agent rows and shows status timing', () => {
    const paneKeyA = makePaneKey(TAB_A, LEAF_A)
    const paneKeyB = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey: paneKeyB,
        tabId: TAB_B,
        title: 'Second session',
        agentType: 'codex',
        startedAt: harness.now - 120_000
      }),
      agentRow({
        paneKey: paneKeyA,
        tabId: TAB_A,
        title: 'First session',
        agentType: 'claude',
        startedAt: harness.now - 60_000
      })
    ]
    setStore({
      tabsByWorktree: {
        'wt-1': [tab(TAB_A, { title: 'First session' }), tab(TAB_B, { title: 'Second session' })]
      },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: paneKeyA,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tabTitle: 'First session',
        status: 'eligible'
      },
      {
        paneKey: paneKeyB,
        tabId: TAB_B,
        leafId: LEAF_B,
        agentType: 'codex',
        tabTitle: 'Second session',
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(2)
    expect(collectText(items[0])).toContain('Codex')
    expect(collectText(items[0])).toContain('Done')
    expect(collectText(items[0])).toContain('2m ago')
    expect(collectText(items[0])).toContain('Second session')
    expect(collectText(items[1])).toContain('Claude')
  })

  it('can target a title-detected agent row that has not reported hook status yet', async () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'idle',
        startedAt: harness.now
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: ['pty-b'] }
    })

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')
    ;(item.props.onSelect as () => void)()
    await flushMicrotasks()

    expect(collectText(item)).toContain('Codex')
    expect(collectText(item)).toContain('Idle')
    expect(harness.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      noteTarget: { tabId: TAB_B, leafId: LEAF_B }
    })
  })

  it('does not offer a title-detected agent row after its live PTY has exited', () => {
    const paneKey = makePaneKey(TAB_B, LEAF_B)
    harness.worktreeAgentRows = [
      agentRow({
        paneKey,
        tabId: TAB_B,
        title: 'Codex',
        agentType: 'codex',
        state: 'done',
        startedAt: harness.now - 60_000
      })
    ]
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_B, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_B]: leafLayout(LEAF_B, 'pty-b') },
      ptyIdsByTabId: { [TAB_B]: [] }
    })

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(collectText(tree)).not.toContain('Active agent session')
  })

  it('does not render an active agent fallback alongside named targets', () => {
    const listedPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A), tab(TAB_B)] },
      terminalLayoutsByTabId: {
        [TAB_A]: leafLayout(LEAF_A, 'pty-a'),
        [TAB_B]: leafLayout(LEAF_B, 'pty-b')
      }
    })
    harness.noteTargets = [
      {
        paneKey: listedPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(1)
    expect(collectText(items[0])).toContain('Claude')
    expect(collectText(tree)).not.toContain('Active agent session')
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('does not render an active agent fallback when the matching derived row is disabled', () => {
    const paneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Codex' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'codex',
        tabTitle: 'Codex',
        status: 'disabled',
        disabledReason: 'Agent status is stale'
      }
    ]

    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(1)
    expect(items[0].props.disabled).toBe(true)
    expect(collectText(tree)).not.toContain('Active agent session')
  })

  it('sends notes to the chosen agent and tracks the send once it succeeds', async () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    const onPromptDelivered = vi.fn()
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'eligible'
      }
    ]

    const tree = render({ onPromptDelivered })
    ;(findByType(tree, 'DropdownMenuItem').props.onSelect as () => void)()
    await flushMicrotasks()

    expect(harness.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: 'my notes',
      noteTarget: { tabId: TAB_A, leafId: LEAF_A }
    })
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(harness.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'claude-code',
      launch_source: 'notes_send',
      request_kind: 'followup'
    })
  })

  it('disables a working agent and never sends to it', () => {
    const statusPaneKey = makePaneKey(TAB_A, LEAF_A)
    setStore({
      tabsByWorktree: { 'wt-1': [tab(TAB_A, { title: 'Terminal 1' })] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') }
    })
    harness.noteTargets = [
      {
        paneKey: statusPaneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: 'claude',
        tabTitle: 'Terminal 1',
        status: 'disabled',
        disabledReason: 'Agent is working'
      }
    ]

    const tree = render()
    const item = findByType(tree, 'DropdownMenuItem')

    expect(item.props.disabled).toBe(true)
    expect(item.props.title).toBe('Agent is working')
    ;(item.props.onSelect as () => void)()
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('does not render an active agent fallback when no agents are derived', () => {
    const tree = render()
    const items = findAllByType(tree, 'DropdownMenuItem')

    expect(items).toHaveLength(0)
    expect(collectText(tree)).not.toContain('Active agent session')
    expect(harness.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })

  it('always offers the new-agent launcher', () => {
    const tree = render()

    expect(findByType(tree, 'QuickLaunchAgentMenuItems').props).toMatchObject({
      worktreeId: 'wt-1',
      groupId: 'group-1',
      prompt: 'my notes',
      launchSource: 'notes_send'
    })
  })
})
