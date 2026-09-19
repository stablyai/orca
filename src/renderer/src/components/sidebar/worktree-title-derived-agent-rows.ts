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
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import { isClaudeIdentityFrameTitle } from '../../../../shared/terminal-title-agent-type'

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
        const row = buildTitleDerivedAgentRow({
          tab,
          leafId,
          title,
          ownerAgentType: resolveTitleDerivedPaneOwner(tab, layout, leafId),
          now: args.now,
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

    const leafId = layout?.activeLeafId ?? collectLeafIds(layout?.root ?? null)[0]
    if (!leafId) {
      continue
    }
    const row = buildTitleDerivedAgentRow({
      tab,
      leafId,
      title: tab.title,
      ownerAgentType: resolveTitleDerivedPaneOwner(tab, layout, leafId),
      now: args.now,
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
  if (!status || !label) {
    return null
  }
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  const titleAgentType = isClaudeAgentsTitle
    ? 'claude'
    : resolveTitleDerivedAgentType(title, label, args.ownerAgentType)
  // Why: a status frame proves activity, not identity, so the resolver drops it.
  // Hook-less agents over SSH (Codex, #8711; OpenCode's '. '/'* ' frames, #8940)
  // surface only decorated task titles; fall back to the pane's known owner instead
  // of hiding the pane. Safe because the `!status || !label` gate above already
  // rejects plain shell titles — this path must never manufacture a row from one.
  const agentType = titleAgentType ?? args.ownerAgentType
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
    // Why not the renderer sequencer: this row is RE-DERIVED from the pane's title on every
    // render, not observed once, so a counter would churn a new revision per frame and break
    // memoization. Deriving revision from `now` keeps the stamp deterministic in the same clock
    // the row already publishes as updatedAt, and monotonic for the pane.
    // The origin tag is the point: `entryState` above collapses a title-derived IDLE row to
    // 'working' while the row itself reports idle. That contradiction is out of scope here —
    // this tag is what makes it findable instead of indistinguishable from a real hook row.
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
    // Load-bearing zero, not a placeholder: `dashboardRowBucketProjection` reads `startedAt === 0`
    // as "title-derived" and short-circuits `unseen`. That is the ONLY reason the `args.now` stamps
    // on `entry` above (updatedAt / stateStartedAt / observation) cannot move this row's bucket.
    // Dashboard bucket caches key their invalidation on the freshness boundary in
    // `isExplicitAgentStatusFresh` alone; give this a real timestamp and every one of them starts
    // serving stale counts, with no test failing at the point of the change.
    startedAt: 0
  }
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

function resolveTitleDerivedPaneOwner(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  leafId: string
): AgentType | null {
  // Why: launchAgent is tab-scoped, so it is pane ownership only while the tab has one
  // leaf; applying it inside a split would let one pane brand its sibling.
  if (layout?.root?.type !== 'leaf' || layout.root.leafId !== leafId) {
    return null
  }
  return resolvePaneAgentOwner({ launchAgent: tab.launchAgent })
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
