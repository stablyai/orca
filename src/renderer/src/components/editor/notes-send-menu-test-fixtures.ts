// Shared fixtures and React-tree walkers for the notes send-menu tests. The
// vi.mock preamble stays per test file; everything here is pure.
import React from 'react'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/types'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'

export type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

export const TAB_A = 'tab-a'
export const TAB_B = 'tab-b'
export const LEAF_A = '11111111-1111-4111-8111-111111111111'
export const LEAF_B = '22222222-2222-4222-8222-222222222222'

export function agentEntry(
  paneKey: string,
  agentType: TuiAgent,
  state: AgentStatusState,
  stateStartedAt: number,
  prompt = ''
): AgentStatusEntry {
  return {
    paneKey,
    state,
    prompt,
    updatedAt: stateStartedAt,
    stateStartedAt,
    agentType,
    stateHistory: []
  }
}

export function tab(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: id,
    defaultTitle: 'Terminal 3',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

/** Bound to the harness clock so callers can omit `startedAt`. */
export function createAgentRowFactory(defaultStartedAt: number) {
  return function agentRow({
    paneKey,
    tabId,
    title,
    agentType,
    state = 'done',
    startedAt = defaultStartedAt,
    prompt = '',
    tabOverrides = {}
  }: {
    paneKey: string
    tabId: string
    title: string
    agentType: TuiAgent
    state?: AgentStatusState | 'idle'
    startedAt?: number
    prompt?: string
    tabOverrides?: Record<string, unknown>
  }): DashboardAgentRowData {
    const entryState: AgentStatusState = state === 'idle' ? 'working' : state
    return {
      paneKey,
      entry: agentEntry(paneKey, agentType, entryState, startedAt, prompt),
      tab: tab(tabId, { title, ...tabOverrides }) as DashboardAgentRowData['tab'],
      agentType,
      state,
      startedAt
    }
  }
}

export function leafLayout(leafId: string, ptyId: string) {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

/** Render function components down to a plain host-element tree. */
export function expand(node: unknown): unknown {
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

export function findAllByType(node: unknown, type: unknown): ReactElementLike[] {
  const found: ReactElementLike[] = []
  visit(node, (entry) => {
    if (entry.type === type) {
      found.push(entry)
    }
  })
  return found
}

export function findByType(node: unknown, type: unknown): ReactElementLike {
  const found = findAllByType(node, type)[0]
  if (!found) {
    throw new Error(`element not found: ${String(type)}`)
  }
  return found
}

export function collectText(node: unknown): string {
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

/** The name and detail line a rendered send-target row shows. */
export function sendTargetRowText(item: unknown): { name: string; detail: string } {
  const spans = findAllByType(item, 'span')
  const byTestId = (id: string): ReactElementLike | undefined =>
    spans.find((span) => span.props['data-testid'] === id)
  return {
    name: collectText(byTestId('send-target-name')),
    detail: collectText(byTestId('send-target-detail'))
  }
}

// Why: titles the shared conversation-name resolver rejects — identity echoes,
// synthetic status labels, cwd-shaped titles, placeholders. The menu renders the
// provider icon and the harness name already, so none of these is a name.
export const JUNK_TITLES: [string, string, TuiAgent][] = [
  ['claude identity echo', '✳ Claude', 'claude'],
  ['gemini identity echo', '✦ Gemini CLI', 'gemini'],
  ['synthetic idle status', 'Codex ready', 'codex'],
  ['synthetic permission status', 'Cursor - action required', 'cursor'],
  ['cwd title over ssh', '⠋ ~/orca/workspaces', 'claude'],
  ['placeholder title', 'Terminal 3', 'claude'],
  ['glyph-only title', '✳', 'claude'],
  ['empty title', '', 'claude']
]

export type SingleTargetScenario = {
  title: string
  agentType: TuiAgent
  prompt?: string
  tabOverrides?: Record<string, unknown>
  withAgentRow?: boolean
  generatedTitlesEnabled?: boolean
}

/** One eligible send target on TAB_A, with the agent row that orders it. */
export function buildSingleTargetScenario(
  scenario: SingleTargetScenario,
  paneKey: string,
  agentRow: ReturnType<typeof createAgentRowFactory>
): {
  agentRows: DashboardAgentRowData[]
  store: Record<string, unknown>
  noteTargets: Record<string, unknown>[]
} {
  const targetTab = tab(TAB_A, { title: scenario.title, ...scenario.tabOverrides })
  return {
    agentRows:
      scenario.withAgentRow === false
        ? []
        : [
            agentRow({
              paneKey,
              tabId: TAB_A,
              title: scenario.title,
              agentType: scenario.agentType,
              state: 'idle',
              prompt: scenario.prompt ?? '',
              tabOverrides: scenario.tabOverrides
            })
          ],
    store: {
      tabsByWorktree: { 'wt-1': [targetTab] },
      terminalLayoutsByTabId: { [TAB_A]: leafLayout(LEAF_A, 'pty-a') },
      settings: { tabAutoGenerateTitle: scenario.generatedTitlesEnabled === true }
    },
    noteTargets: [
      {
        paneKey,
        tabId: TAB_A,
        leafId: LEAF_A,
        agentType: scenario.agentType,
        tab: targetTab,
        status: 'eligible'
      }
    ]
  }
}
