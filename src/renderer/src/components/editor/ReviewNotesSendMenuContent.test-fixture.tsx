import React from 'react'
import type * as ReactModule from 'react'
import { vi, type Mock } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { NotesSendAgentTarget } from '@/lib/notes-send-agent-targets'
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

type NotesSendMenuFixtureHarness = {
  storeState: Record<string, unknown>
  sendMessageToAgent: Mock
  track: Mock
  toastMessage: Mock
  worktreeAgentRows: DashboardAgentRowData[]
  noteTargets: NotesSendAgentTarget[]
  now: number
}

const harness: NotesSendMenuFixtureHarness = vi.hoisted(() => ({
  storeState: {} as Record<string, unknown>,
  sendMessageToAgent: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  worktreeAgentRows: [] as DashboardAgentRowData[],
  noteTargets: new Array<NotesSendAgentTarget>(),
  now: 600_000
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react')
  return {
    ...actual,
    useCallback<T extends (...args: never[]) => unknown>(callback: T): T {
      return callback
    },
    useMemo<T>(factory: () => T): T {
      return factory()
    },
    useSyncExternalStore<T>(_subscribe: unknown, getSnapshot: () => T): T {
      return getSnapshot()
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
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(harness.storeState),
    {
      getState: () => harness.storeState
    }
  )
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector
}))

vi.mock('@/runtime/structured-chat-name-observation', () => ({
  useStructuredChatTabNames: () => new Map(),
  getStructuredChatTabNames: () => new Map()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status)
}))

vi.mock('@/lib/agent-message-send', () => ({
  sendMessageToAgent: harness.sendMessageToAgent
}))

vi.mock('@/lib/notes-send-agent-targets', () => ({
  deriveNotesSendAgentTargets: () => harness.noteTargets
}))

vi.mock('@/lib/telemetry', () => ({
  track: harness.track
}))

vi.mock('@/hooks/use-now', () => ({
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
      case 'failed':
        return 'Failed'
      case 'interrupted':
        return 'Interrupted'
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

// Keep real Sonner state to verify a settled toast’s type.
vi.mock(import('sonner'), async (importOriginal) => {
  const actual = await importOriginal()
  const realMessage = actual.toast.message
  const message: typeof realMessage = (...args) => {
    harness.toastMessage(...args)
    return realMessage(...args)
  }
  return { ...actual, toast: Object.assign(actual.toast, { message }) }
})

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
  agentType = 'claude',
  state = 'done',
  startedAt = harness.now,
  prompt = ''
}: {
  paneKey: string
  tabId: string
  title: string
  agentType?: TuiAgent
  prompt?: string
  state?: AgentStatusState | 'idle'
  startedAt?: number
}): DashboardAgentRowData {
  const entryState: AgentStatusState = state === 'idle' ? 'working' : state
  return {
    paneKey,
    entry: { ...agentEntry(paneKey, agentType, entryState, startedAt), prompt },
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

export {
  TAB_A,
  TAB_B,
  LEAF_A,
  LEAF_B,
  hookRuntime,
  harness,
  agentEntry,
  agentRow,
  tab,
  leafLayout,
  setStore,
  findAllByType,
  findByType,
  collectText,
  render,
  flushMicrotasks
}
