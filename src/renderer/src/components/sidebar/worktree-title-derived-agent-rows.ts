import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel, isClaudeManagementTitle } from '@/lib/agent-status'
import { containsBrailleSpinner } from '../../../../shared/agent-title-core'
import {
  classifyTitleActivity,
  resolveCommittedTitleAgentType,
  resolveTitleActivityLabel
} from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { hasCanonicalBrailleAgentTitleIdentity } from '../../../../shared/explicit-agent-title-identity'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab,
  TuiAgent
} from '../../../../shared/types'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../shared/agent-title-owner'

const EMPTY_RUNTIME_TITLES: Record<string, Record<number, string>> = {}
const EMPTY_LIVE_PTY_IDS: Record<string, string[]> = {}
const EMPTY_TERMINAL_LAYOUTS: Record<string, TerminalLayoutSnapshot | undefined> = {}
const EMPTY_PANE_FOREGROUND_AGENTS: Record<string, PaneForegroundAgentEntry> = {}

export function buildTitleDerivedAgentRows(args: {
  tabs: TerminalTab[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  paneForegroundAgentByPaneKey?: Record<string, PaneForegroundAgentEntry>
  seenPaneKeys: Set<string>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const runtimePaneTitlesByTabId = args.runtimePaneTitlesByTabId ?? EMPTY_RUNTIME_TITLES
  const ptyIdsByTabId = args.ptyIdsByTabId ?? EMPTY_LIVE_PTY_IDS
  const terminalLayoutsByTabId = args.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS
  const paneForegroundAgentByPaneKey =
    args.paneForegroundAgentByPaneKey ?? EMPTY_PANE_FOREGROUND_AGENTS

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
    const rootLeafIds = collectLeafIds(layout?.root ?? null)
    const currentLeafIds = new Set(
      rootLeafIds.length > 0 ? rootLeafIds : Object.keys(layout?.ptyIdsByLeafId ?? {})
    )

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
        const row = buildTitleDerivedAgentRow({
          tab,
          leafId,
          title,
          now: args.now,
          runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey,
          paneForegroundAgentByPaneKey
        })
        if (!row || args.seenPaneKeys.has(row.paneKey)) {
          continue
        }
        rows.push(row)
        args.seenPaneKeys.add(row.paneKey)
      }
    } else {
      const leafId = layout?.activeLeafId ?? collectLeafIds(layout?.root ?? null)[0]
      if (leafId) {
        const row = buildTitleDerivedAgentRow({
          tab,
          leafId,
          title: tab.title,
          now: args.now,
          runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey,
          paneForegroundAgentByPaneKey
        })
        if (row && !args.seenPaneKeys.has(row.paneKey)) {
          rows.push(row)
          args.seenPaneKeys.add(row.paneKey)
        }
      }
    }

    for (const paneKey of Object.keys(paneForegroundAgentByPaneKey)) {
      const parsed = parsePaneKey(paneKey)
      if (
        parsed?.tabId !== tab.id ||
        args.seenPaneKeys.has(paneKey) ||
        (currentLeafIds.size > 0 && !currentLeafIds.has(parsed.leafId))
      ) {
        continue
      }
      const title =
        layout?.titlesByLeafId?.[parsed.leafId] ??
        (layout?.activeLeafId === parsed.leafId ? tab.title : '')
      const row = buildTitleDerivedAgentRow({
        tab,
        leafId: parsed.leafId,
        title,
        now: args.now,
        runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey,
        paneForegroundAgentByPaneKey
      })
      if (row) {
        rows.push(row)
        args.seenPaneKeys.add(row.paneKey)
      }
    }
  }

  return rows
}

/**
 * Constructs a synthetic dashboard row from title and foreground-process
 * evidence, normalising Pi-compatible agent names to their owner.
 */
function buildTitleDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  title: string
  now: number
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
}): DashboardAgentRow | null {
  const title = normalizeCompatibleAgentTitleForOwner(args.title, args.tab.launchAgent)
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const foreground = args.paneForegroundAgentByPaneKey[paneKey]
  if (foreground?.shellForeground) {
    return null
  }
  const foregroundAgentType =
    resolveCompatibleAgentTypeForOwner(foreground?.agent, args.tab.launchAgent) ?? null
  const isClaudeAgentsTitle = isClaudeManagementTitle(title)
  // Why: `claude agents` is a live Claude Code Agent Teams surface, but the
  // shared detector keeps it neutral so runtime liveness probes do not treat
  // the management/list screen as active work.
  const titleStatus = isClaudeAgentsTitle ? 'idle' : classifyTitleActivity(title)
  const label = isClaudeAgentsTitle ? 'Claude Code' : resolveTitleActivityLabel(title)
  const resolvedTitleAgentType = isClaudeAgentsTitle
    ? 'claude'
    : resolveTitleDerivedAgentType(title)
  const knownAgentType = foregroundAgentType ?? args.tab.launchAgent
  // Why: braille is shared; a conflicting provider name may be task text.
  const titleAgentType =
    resolvedTitleAgentType &&
    knownAgentType &&
    resolvedTitleAgentType !== knownAgentType &&
    containsBrailleSpinner(title) &&
    !hasCanonicalBrailleAgentTitleIdentity(title, resolvedTitleAgentType)
      ? null
      : resolvedTitleAgentType
  const titleBelongsToForeground =
    !foregroundAgentType || !titleAgentType || titleAgentType === foregroundAgentType
  // Why: a foreground process proves presence, not active work.
  const status = titleBelongsToForeground
    ? (titleStatus ?? (foregroundAgentType ? 'idle' : null))
    : 'idle'
  if (!status) {
    return null
  }
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  // Why: braille proves activity, not identity. Hook-less SSH agents may expose
  // only spinner+cwd, so use launch identity only when that spinner is present.
  // Residual: a split pane with its own braille title inherits launchAgent.
  const agentType =
    foregroundAgentType ??
    titleAgentType ??
    (containsBrailleSpinner(title) ? (args.tab.launchAgent ?? null) : null)
  if (!agentType) {
    return null
  }
  const rowLabel =
    !foregroundAgentType && titleAgentType && label ? label : formatAgentTypeLabel(agentType)
  const rowState = titleStatusToRowState(status)
  const secondary =
    status === 'permission' ? 'Needs input' : status === 'working' ? 'Running' : 'Idle'
  const entryState: AgentStatusState = rowState === 'waiting' ? 'waiting' : 'working'
  const entry: AgentStatusEntry = {
    paneKey,
    state: entryState,
    prompt: rowLabel,
    updatedAt: args.now,
    stateStartedAt: args.now,
    stateHistory: [],
    agentType,
    terminalTitle: title,
    lastAssistantMessage: secondary,
    ...(orchestration ? { orchestration } : {})
  }
  return {
    paneKey,
    entry,
    tab: args.tab,
    agentType,
    rowSource: 'live',
    state: rowState,
    startedAt: 0
  }
}

export function resolveTitleDerivedAgentType(title: string): TuiAgent | null {
  return resolveCommittedTitleAgentType(title)
}

/**
 * Determines the agent type from a terminal title, normalising Pi-compatible
 * agents to their authoritative owner if specified.
 */
export function resolveAgentTypeFromTerminalTitle(
  title: string | null | undefined,
  ownerAgentType?: AgentType | null
): AgentType | null {
  if (!title) {
    return null
  }
  const normalizedTitle = normalizeCompatibleAgentTitleForOwner(title, ownerAgentType)
  return (
    resolveCompatibleAgentTypeForOwner(
      resolveTitleDerivedAgentType(normalizedTitle),
      ownerAgentType
    ) ?? null
  )
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
