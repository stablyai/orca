import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { detectAgentStatusFromTitle, getAgentLabel } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'

const EMPTY_RUNTIME_TITLES: Record<string, Record<number, string>> = {}
const EMPTY_LIVE_PTY_IDS: Record<string, string[]> = {}
const EMPTY_TERMINAL_LAYOUTS: Record<string, TerminalLayoutSnapshot | undefined> = {}

const TITLE_AGENT_LABEL_TO_TYPE: Record<string, AgentType> = {
  'Claude Code': 'claude',
  OpenClaude: 'openclaude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  'GitHub Copilot': 'copilot',
  Grok: 'grok',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi'
}

export function buildTitleDerivedAgentRows(args: {
  tabs: TerminalTab[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  seenPaneKeys: Set<string>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const runtimePaneTitlesByTabId = args.runtimePaneTitlesByTabId ?? EMPTY_RUNTIME_TITLES
  const ptyIdsByTabId = args.ptyIdsByTabId ?? EMPTY_LIVE_PTY_IDS
  const terminalLayoutsByTabId = args.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS

  for (const tab of args.tabs) {
    if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
      continue
    }
    const layout = terminalLayoutsByTabId[tab.id]
    const paneTitles = runtimePaneTitlesByTabId[tab.id]
    const paneTitleEntries =
      paneTitles && Object.keys(paneTitles).length > 0
        ? Object.entries(paneTitles).sort(([a], [b]) => Number(a) - Number(b))
        : []

    if (paneTitleEntries.length > 0) {
      for (const [paneId, title] of paneTitleEntries) {
        const leafId = resolveLeafIdForTitleFallback({
          layout,
          paneTitleEntries,
          paneId: Number(paneId),
          title
        })
        if (!leafId) {
          continue
        }
        const row = buildTitleDerivedAgentRow({ tab, leafId, title, now: args.now })
        if (!row || args.seenPaneKeys.has(row.paneKey)) {
          continue
        }
        rows.push(row)
        args.seenPaneKeys.add(row.paneKey)
      }
      continue
    }

    const leafId = layout?.activeLeafId ?? collectLeafIds(layout?.root ?? null)[0]
    if (!leafId) {
      continue
    }
    const row = buildTitleDerivedAgentRow({ tab, leafId, title: tab.title, now: args.now })
    if (!row || args.seenPaneKeys.has(row.paneKey)) {
      continue
    }
    rows.push(row)
    args.seenPaneKeys.add(row.paneKey)
  }

  return rows
}

function buildTitleDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  title: string
  now: number
}): DashboardAgentRow | null {
  const status = detectAgentStatusFromTitle(args.title)
  const label = getAgentLabel(args.title)
  if (!status || !label) {
    return null
  }
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const agentType = TITLE_AGENT_LABEL_TO_TYPE[label] ?? 'unknown'
  const rowState = titleStatusToRowState(status)
  const secondary =
    status === 'permission' ? 'Needs input' : status === 'working' ? 'Running' : 'Idle'
  const entryState: AgentStatusState = rowState === 'waiting' ? 'waiting' : 'working'
  const entry: AgentStatusEntry = {
    paneKey,
    state: entryState,
    prompt: label,
    updatedAt: args.now,
    stateStartedAt: args.now,
    stateHistory: [],
    agentType,
    terminalTitle: args.title,
    lastAssistantMessage: secondary
  }
  return {
    paneKey,
    entry,
    tab: args.tab,
    agentType,
    state: rowState,
    startedAt: 0
  }
}

function titleStatusToRowState(
  status: 'working' | 'permission' | 'idle'
): AgentStatusState | 'idle' {
  if (status === 'permission') {
    return 'waiting'
  }
  if (status === 'working') {
    return 'working'
  }
  return 'idle'
}

function resolveLeafIdForTitleFallback(args: {
  layout: TerminalLayoutSnapshot | undefined
  paneTitleEntries: [string, string][]
  paneId: number
  title: string
}): string | null {
  const matchingTitleLeafIds = Object.entries(args.layout?.titlesByLeafId ?? {})
    .filter(([, title]) => title === args.title)
    .map(([leafId]) => leafId)
  if (matchingTitleLeafIds.length === 1) {
    return matchingTitleLeafIds[0]
  }

  const leafIds = collectLeafIds(args.layout?.root ?? null)
  if (leafIds.length === 1) {
    return leafIds[0]
  }

  const paneIndex = args.paneTitleEntries.findIndex(([paneId]) => Number(paneId) === args.paneId)
  return paneIndex >= 0 ? (leafIds[paneIndex] ?? null) : null
}

function collectLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}
