import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel, isClaudeManagementTitle } from '@/lib/agent-status'
import { containsBrailleSpinner } from '../../../../shared/agent-title-core'
import { classifyTitleActivity, resolveTitleActivityLabel } from '@/lib/pane-agent-evidence'
import {
  resolveRuntimePaneTitleForLayoutLeaf,
  resolveRuntimePaneTitleLeafIdFromRoot
} from '@/lib/runtime-pane-title-leaf-id'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../../shared/types'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from '../../../../shared/agent-title-owner'

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
  Devin: 'devin',
  Antigravity: 'antigravity',
  OpenCode: 'opencode',
  Aider: 'aider',
  Cursor: 'cursor',
  Droid: 'droid',
  Hermes: 'hermes',
  Pi: 'pi',
  OMP: 'omp'
}

const CLAUDE_AGENT_TOKEN_RE = /(?<![\w./\\-])claude(?![\w./\\-])/i

export function buildTitleDerivedAgentRows(args: {
  tabs: TerminalTab[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  suppressedTitleDerivedLeafIdsByTabId?: Record<string, Record<string, true>>
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
    const unfilteredPaneTitles = runtimePaneTitlesByTabId[tab.id]
    const paneTitles = filterRuntimePaneTitlesToLayoutBindings(unfilteredPaneTitles, layout)
    const layoutLeafIds = collectLeafIds(layout?.root ?? null)
    const hasRuntimePaneTitles = paneTitles && Object.keys(paneTitles).length > 0
    const allowLaunchAgentSpinnerFallback = layoutLeafIds.length <= 1

    const ptyIdsByLeafId = layout?.ptyIdsByLeafId
    const gateTitleDerivedLeafOnLivePty =
      ptyIdsByLeafId !== undefined && Object.keys(ptyIdsByLeafId).length > 0

    const suppressedLeafIds = args.suppressedTitleDerivedLeafIdsByTabId?.[tab.id]

    if (hasRuntimePaneTitles && layoutLeafIds.length > 0) {
      for (const leafId of layoutLeafIds) {
        if (suppressedLeafIds?.[leafId]) {
          continue
        }
        if (gateTitleDerivedLeafOnLivePty && !ptyIdsByLeafId[leafId]) {
          continue
        }
        const title = resolveRuntimePaneTitleForLayoutLeaf(layout, paneTitles, leafId)
        if (!title) {
          continue
        }
        const row = buildTitleDerivedAgentRow({
          tab,
          leafId,
          title,
          now: args.now,
          allowLaunchAgentSpinnerFallback,
          runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey
        })
        if (!row || args.seenPaneKeys.has(row.paneKey)) {
          continue
        }
        rows.push(row)
        args.seenPaneKeys.add(row.paneKey)
      }
      continue
    }

    if (hasRuntimePaneTitles) {
      continue
    }

    const hadUnfilteredRuntimePaneTitles =
      unfilteredPaneTitles && Object.keys(unfilteredPaneTitles).length > 0
    // Why: pane titles existed but none matched a live layout leaf — they belong
    // to removed split panes. Suppress the tab title fallback so stale agent
    // output is not re-synthesized.
    if (hadUnfilteredRuntimePaneTitles) {
      continue
    }

    // Why: suppress polluted tab titles (spinner + named agent) when there is no
    // launchAgent to back the attribution. Bare spinners with a launchAgent pass
    // through so launchAgent can provide the type.
    if (
      !tab.launchAgent &&
      containsBrailleSpinner(tab.title) &&
      resolveAgentTypeFromTerminalTitle(tab.title)
    ) {
      continue
    }

    const leafId = layout?.activeLeafId ?? collectLeafIds(layout?.root ?? null)[0]
    if (!leafId || suppressedLeafIds?.[leafId]) {
      continue
    }
    const row = buildTitleDerivedAgentRow({
      tab,
      leafId,
      title: tab.title,
      now: args.now,
      allowLaunchAgentSpinnerFallback,
      runtimeAgentOrchestrationByPaneKey: args.runtimeAgentOrchestrationByPaneKey
    })
    if (!row || args.seenPaneKeys.has(row.paneKey)) {
      continue
    }
    rows.push(row)
    args.seenPaneKeys.add(row.paneKey)
  }

  return rows
}

/**
 * Constructs a dashboard agent row from a terminal tab's title fallback,
 * normalising Pi-compatible agent names to their owner.
 */
function filterRuntimePaneTitlesToLayoutBindings(
  paneTitles: Record<number, string> | undefined,
  layout: TerminalLayoutSnapshot | undefined
): Record<number, string> | undefined {
  if (!paneTitles) {
    return paneTitles
  }
  const layoutLeafIds = collectLeafIds(layout?.root ?? null)
  if (layoutLeafIds.length === 0) {
    return paneTitles
  }
  const liveLeafIds = new Set(layoutLeafIds)
  const paneIdsByLeafId = layout?.paneIdsByLeafId
  if (paneIdsByLeafId && Object.keys(paneIdsByLeafId).length > 0) {
    const livePaneIds = new Set(Object.values(paneIdsByLeafId))
    const filtered: Record<number, string> = {}
    for (const [paneId, title] of Object.entries(paneTitles)) {
      const numericPaneId = Number(paneId)
      if (livePaneIds.has(numericPaneId)) {
        filtered[numericPaneId] = title
      }
    }
    return filtered
  }
  const filtered: Record<number, string> = {}
  for (const [paneId, title] of Object.entries(paneTitles)) {
    const numericPaneId = Number(paneId)
    const leafId = resolveRuntimePaneTitleLeafIdFromRoot(layout?.root, String(numericPaneId))
    if (leafId && liveLeafIds.has(leafId)) {
      filtered[numericPaneId] = title
    }
  }
  return filtered
}

function buildTitleDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  title: string
  now: number
  allowLaunchAgentSpinnerFallback: boolean
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
}): DashboardAgentRow | null {
  const title = normalizeCompatibleAgentTitleForOwner(args.title, args.tab.launchAgent)
  const isClaudeAgentsTitle = isClaudeManagementTitle(title)
  // Why: `claude agents` is a live Claude Code Agent Teams surface, but the
  // shared detector keeps it neutral so runtime liveness probes do not treat
  // the management/list screen as active work.
  const status = isClaudeAgentsTitle ? 'idle' : classifyTitleActivity(title)
  const label = isClaudeAgentsTitle ? 'Claude Code' : resolveTitleActivityLabel(title)
  if (!status || !label) {
    return null
  }
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  const titleAgentType = isClaudeAgentsTitle ? 'claude' : resolveTitleDerivedAgentType(title, label)
  // Why: a braille spinner proves activity, not identity, so the resolver drops
  // it. Hook-less agents over SSH (Codex, #8711) surface only spinner+cwd titles;
  // fall back to the tab's launch identity instead of hiding the pane. Gated on
  // the spinner on purpose — unlike the hook path's unconditional launchAgent
  // fallback (resolveRowAgentType), this path manufactures agent-ness from a
  // title alone, so a non-agent title must never become a row. Residual: a split
  // pane whose own title carries a braille glyph is still attributed to launchAgent.
  const agentType =
    titleAgentType ??
    (args.allowLaunchAgentSpinnerFallback && containsBrailleSpinner(title)
      ? (args.tab.launchAgent ?? null)
      : null)
  if (!agentType) {
    return null
  }
  const rowLabel = titleAgentType ? label : formatAgentTypeLabel(agentType)
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

export function resolveTitleDerivedAgentType(title: string, label: string): AgentType | null {
  const agentType = TITLE_AGENT_LABEL_TO_TYPE[label] ?? 'unknown'
  if (agentType !== 'claude') {
    return agentType
  }
  // Why: Claude's task-title spinner heuristic has no provider identity. In
  // split panes it can match arbitrary terminal spinners, so sidebar rows only
  // accept Claude when the title itself names Claude.
  return CLAUDE_AGENT_TOKEN_RE.test(title) ? agentType : null
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
  const label = resolveTitleActivityLabel(normalizedTitle)
  return label
    ? (resolveCompatibleAgentTypeForOwner(
        resolveTitleDerivedAgentType(normalizedTitle, label),
        ownerAgentType
      ) ?? null)
    : null
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

function collectLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}
