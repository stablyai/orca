import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel, isClaudeManagementTitle } from '@/lib/agent-status'
import { isCursorAgentTitle } from '../../../../shared/agent-title-core'
import { classifyTitleActivity, resolveTitleActivityLabel } from '@/lib/pane-agent-evidence'
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
} from '../../../../shared/terminal-tab-types'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner,
  type CompatibleAgentOwnerOptions
} from '../../../../shared/agent-title-owner'
import { isClaudeIdentityFrameTitle } from '../../../../shared/terminal-title-agent-type'
import { buildTitleDerivedIdleAgentRow } from './worktree-title-derived-agent-idle-row'
import {
  resolveLaunchAgentOwnerLeafId,
  resolveTitleDerivedPaneOwner
} from './worktree-title-derived-agent-owner'

/** Fixed, not per-process: title rows are a pure projection of the current title, so they are
 *  comparable across restarts in a way a sequenced authority's rows are not. Ordering against
 *  any other authority's rows is undefined — see agent-status-observation.ts. */
export const TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID = 'renderer-title-projection'

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
    const layoutLeafIds = collectLeafIds(layout?.root ?? null)
    // Why: launchAgent is tab-scoped. Idle fallback may only bind to the sole
    // launch-owning leaf — multi-leaf tabs must not mint Idle rows for every
    // neutral sibling shell (#10130 / CodeRabbit on #10178).
    const launchAgentOwnerLeafId = resolveLaunchAgentOwnerLeafId(tab, layout, layoutLeafIds)
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
          title,
          fallbackLeafId: launchAgentOwnerLeafId
        })
        if (!leafId) {
          continue
        }
        const row = buildTitleDerivedAgentRow({
          tab,
          leafId,
          title,
          ownerAgentType: resolveTitleDerivedPaneOwner({ tab, layout, layoutLeafIds, leafId }),
          now: args.now,
          allowLaunchAgentIdleFallback: launchAgentOwnerLeafId === leafId,
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

    // Why: tab-wide title metadata belongs to its retained launch owner even when a split's active leaf or the layout snapshot is unavailable.
    const leafId = launchAgentOwnerLeafId ?? layout?.activeLeafId ?? layoutLeafIds[0]
    if (!leafId) {
      continue
    }
    const allowLaunchAgentIdleFallback = launchAgentOwnerLeafId === leafId
    const row = buildTitleDerivedAgentRow({
      tab,
      leafId,
      title: tab.title,
      ownerAgentType: resolveTitleDerivedPaneOwner({ tab, layout, layoutLeafIds, leafId }),
      now: args.now,
      allowLaunchAgentIdleFallback,
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
function buildTitleDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  title: string
  ownerAgentType: AgentType | null
  now: number
  /** Why: idle launchAgent fallback is only safe for the launch-owning leaf. */
  allowLaunchAgentIdleFallback?: boolean
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
}): DashboardAgentRow | null {
  // Why launchAgent, not ownerAgentType: this only rewrites a title within its own identity
  // group (OMP wraps Pi and emits Pi frames), which stays correct in a split. Pane ownership
  // is a separate, stricter question — it decides identity, so it uses ownerAgentType below.
  const title = normalizeCompatibleAgentTitleForOwner(args.title, args.tab.launchAgent, {
    ownerIsLaunch: Boolean(args.tab.launchAgent)
  })
  const isClaudeAgentsTitle = isClaudeManagementTitle(title)
  // Why: `claude agents` is a live Claude Code Agent Teams surface, but the
  // shared detector keeps it neutral so runtime liveness probes do not treat
  // the management/list screen as active work.
  // Why (cursor): the native `cursor agent` literal is deliberately status-less so a
  // redraw cannot stomp hook state — but it still identifies a live pane, so the row
  // reads idle instead of vanishing (#10258).
  const status = isClaudeAgentsTitle
    ? 'idle'
    : (classifyTitleActivity(title) ?? (isCursorAgentTitle(title) ? 'idle' : null))
  const label = isClaudeAgentsTitle ? 'Claude Code' : resolveTitleActivityLabel(title)
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  const titleAgentType =
    status && label
      ? isClaudeAgentsTitle
        ? 'claude'
        : resolveTitleDerivedAgentType(title, label, args.ownerAgentType)
      : null
  // Why: a status frame proves activity, not identity; use the pane's known owner
  // for hook-less SSH panes after the title has established agent activity.
  const agentType = titleAgentType ?? args.ownerAgentType
  const launchAgent = args.tab.launchAgent ?? null

  if (status && label) {
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
      ...(orchestration ? { orchestration } : {}),
      observation: {
        origin: 'title',
        authorityId: TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID,
        incarnation: 0,
        revision: args.now,
        observedAt: args.now,
        kind: 'snapshot'
      }
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

  // Why: SSH Codex can lose hooks after a turn; other agents must keep title-based identity.
  if (
    launchAgent !== 'codex' ||
    !args.allowLaunchAgentIdleFallback ||
    status === 'working' ||
    status === 'permission'
  ) {
    return null
  }
  return buildTitleDerivedIdleAgentRow({
    paneKey,
    tab: args.tab,
    title,
    launchAgent,
    now: args.now,
    authorityId: TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID,
    orchestration
  })
}

export function resolveTitleDerivedAgentType(
  title: string,
  label: string,
  ownerAgentType?: AgentType | null
): AgentType | null {
  const agentType = TITLE_AGENT_LABEL_TO_TYPE[label] ?? 'unknown'
  if (agentType !== 'claude') {
    return agentType
  }
  // Why: Claude's task-title spinner heuristic has no provider identity. In
  // split panes it can match arbitrary terminal spinners, so sidebar rows only
  // accept Claude when the title itself names Claude.
  if (!CLAUDE_AGENT_TOKEN_RE.test(title)) {
    return null
  }
  // Why: a "claude" word inside another agent's task text is a mention, not identity.
  // Only a title that PRESENTS Claude may take a pane away from its known owner (#8940).
  const owner = ownerAgentType && ownerAgentType !== 'unknown' ? ownerAgentType : null
  if (owner && owner !== 'claude' && !isClaudeIdentityFrameTitle(title)) {
    return null
  }
  return agentType
}

/**
 * Determines the agent type from a terminal title, normalising Pi-compatible
 * agents to their authoritative owner if specified.
 */
export function resolveAgentTypeFromTerminalTitle(
  title: string | null | undefined,
  ownerAgentType?: AgentType | null,
  options?: CompatibleAgentOwnerOptions
): AgentType | null {
  if (!title) {
    return null
  }
  const normalizedTitle = normalizeCompatibleAgentTitleForOwner(title, ownerAgentType, options)
  const label = resolveTitleActivityLabel(normalizedTitle)
  return label
    ? (resolveCompatibleAgentTypeForOwner(
        resolveTitleDerivedAgentType(normalizedTitle, label, ownerAgentType),
        ownerAgentType,
        options
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

function resolveLeafIdForTitleFallback(args: {
  layout: TerminalLayoutSnapshot | undefined
  paneTitleEntries: [string, string][]
  paneId: number
  title: string
  fallbackLeafId: string | null
}): string | null {
  const matchingTitleLeafIds = Object.entries(args.layout?.titlesByLeafId ?? {})
    .filter(([, title]) => title === args.title)
    .map(([leafId]) => leafId)
  if (matchingTitleLeafIds.length === 1) {
    return matchingTitleLeafIds[0]
  }

  if (!args.layout?.root && args.fallbackLeafId && args.paneTitleEntries.length === 1) {
    return args.fallbackLeafId
  }

  const leafIds = collectLeafIds(args.layout?.root ?? null)
  if (leafIds.length === 1) {
    return leafIds[0]
  }

  const paneIndex = args.paneTitleEntries.findIndex(([paneId]) => Number(paneId) === args.paneId)
  return paneIndex !== -1 ? (leafIds[paneIndex] ?? null) : null
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
