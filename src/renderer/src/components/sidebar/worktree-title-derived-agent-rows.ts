import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel, isClaudeManagementTitle } from '@/lib/agent-status'
import { isCursorAgentTitle, type AgentTitleActivity } from '../../../../shared/agent-title-core'
import { readAgentTitleActivity } from '../../../../shared/agent-title-status'
import { resolveTitleActivityLabel } from '@/lib/pane-agent-evidence'
import { agentNoStatusReportedLabel, type AgentRowState } from '@/lib/agent-row-decay-state'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import { FIRST_PANE_ID } from '../../../../shared/pane-key'
import {
  resolveRuntimePaneTitleLeafIdFromRoot,
  resolveRuntimePaneTitleLeafIdFromSparseSlots,
  collectRuntimePaneLeafIds
} from '@/lib/runtime-pane-title-leaf-id'
import { isTerminalLeafId, makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner,
  type CompatibleAgentOwnerOptions
} from '../../../../shared/agent-title-owner'
import { resolvePaneAgentOwner } from '../../../../shared/pane-agent-owner'
import {
  resolveTitleDerivedAgentType,
  resolveTitleDerivedPaneAgent,
  type TitleDerivedPaneForeground
} from './title-derived-pane-agent-identity'

/** Fixed, not per-process: title rows are a pure projection of current pane facts, so they are
 *  comparable across restarts in a way a sequenced authority's rows are not. Ordering against
 *  any other authority's rows is undefined — see agent-status-observation.ts. */
export const TITLE_DERIVED_AGENT_ROW_AUTHORITY_ID = 'renderer-title-projection'

const EMPTY_RUNTIME_TITLES: Record<string, Record<number, string>> = {}
const EMPTY_LIVE_PTY_IDS: Record<string, string[]> = {}
const EMPTY_TERMINAL_LAYOUTS: Record<string, TerminalLayoutSnapshot | undefined> = {}
const EMPTY_PANE_FOREGROUND: Record<string, TitleDerivedPaneForeground> = {}

export function buildTitleDerivedAgentRows(args: {
  tabs: TerminalTab[]
  runtimePaneTitlesByTabId?: Record<string, Record<number, string>>
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot | undefined>
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
  paneForegroundAgentByPaneKey?: Record<string, TitleDerivedPaneForeground>
  seenPaneKeys: Set<string>
  now: number
}): DashboardAgentRow[] {
  const rows: DashboardAgentRow[] = []
  const runtimePaneTitlesByTabId = args.runtimePaneTitlesByTabId ?? EMPTY_RUNTIME_TITLES
  const ptyIdsByTabId = args.ptyIdsByTabId ?? EMPTY_LIVE_PTY_IDS
  const terminalLayoutsByTabId = args.terminalLayoutsByTabId ?? EMPTY_TERMINAL_LAYOUTS
  const paneForegroundAgentByPaneKey = args.paneForegroundAgentByPaneKey ?? EMPTY_PANE_FOREGROUND

  for (const tab of args.tabs) {
    if (!tabHasLivePty(ptyIdsByTabId, tab.id)) {
      continue
    }
    const layout = terminalLayoutsByTabId[tab.id]
    const paneTitles = runtimePaneTitlesByTabId[tab.id]
    const paneTitleEntries =
      paneTitles && Object.keys(paneTitles).length > 0
        ? Object.entries(paneTitles).sort(([a], [b]) => {
            const paneIdA = Number(a)
            const paneIdB = Number(b)
            const isLiveA = paneIdA >= FIRST_PANE_ID
            return isLiveA !== paneIdB >= FIRST_PANE_ID ? (isLiveA ? -1 : 1) : paneIdA - paneIdB
          })
        : []

    if (paneTitleEntries.length > 0) {
      // Why: hoisted per tab — the leaf lists are layout-derived, not pane-derived.
      const leafIds = collectRuntimePaneLeafIds(layout?.root ?? null)
      const liveSlotIds = paneTitleEntries
        .map(([paneId]) => Number(paneId))
        .filter((paneId) => paneId >= FIRST_PANE_ID)
      // Why: pane ids only encode creation order while they are the dense sequence a
      // fresh mount or replay allocates; an in-session pane close leaves them sparse.
      const liveSlotsAreDense =
        liveSlotIds.length === leafIds.length &&
        liveSlotIds.every((paneId, index) => paneId === FIRST_PANE_ID + index)
      for (const [paneId, title] of paneTitleEntries) {
        const leafId = resolveLeafIdForTitleFallback({
          layout,
          leafIds,
          ptyIds: ptyIdsByTabId[tab.id] ?? [],
          liveSlotIds,
          liveSlotsAreDense,
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
          paneForegroundAgentByPaneKey,
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

    const leafId = layout?.activeLeafId ?? collectRuntimePaneLeafIds(layout?.root ?? null)[0]
    if (!leafId) {
      continue
    }
    const row = buildTitleDerivedAgentRow({
      tab,
      leafId,
      title: tab.title,
      ownerAgentType: resolveTitleDerivedPaneOwner(tab, layout, leafId),
      paneForegroundAgentByPaneKey,
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
  paneForegroundAgentByPaneKey: Record<string, TitleDerivedPaneForeground>
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
  // stays instead of vanishing (#10258), saying nothing about what Cursor is doing.
  const titleStatus: AgentTitleActivity | null = isClaudeAgentsTitle
    ? 'idle'
    : (readAgentTitleActivity(title) ?? (isCursorAgentTitle(title) ? 'unreported' : null))
  const label = isClaudeAgentsTitle ? 'Claude Code' : resolveTitleActivityLabel(title)
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  // Why: a status frame proves activity, not identity (Codex over SSH, #8711; OpenCode's
  // '. '/'* ' frames, #8940), so a title names an agent only when it carries both.
  const titleAgentType =
    !titleStatus || !label
      ? null
      : isClaudeAgentsTitle
        ? 'claude'
        : resolveTitleDerivedAgentType(title, label, args.ownerAgentType)
  const agentType = resolveTitleDerivedPaneAgent({
    title,
    defaultTitle: args.tab.defaultTitle,
    titleShowsActivity: Boolean(titleStatus && label),
    titleAgentType,
    launchAgentType: args.ownerAgentType,
    foreground: args.paneForegroundAgentByPaneKey[paneKey]
  })
  if (!agentType) {
    return null
  }
  // Why: the title sets activity only; a plain title on a process-identified pane says nothing.
  const status = titleStatus ?? 'unreported'
  const rowLabel = agentType === titleAgentType && label ? label : formatAgentTypeLabel(agentType)
  const rowState = titleStatusToRowState(status)
  const secondary = titleActivitySecondaryText(status)
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
    // Why not the renderer sequencer: this row is RE-DERIVED from the pane's facts on every
    // render, not observed once, so a counter would churn a new revision per frame and break
    // memoization. Deriving revision from `now` keeps the stamp deterministic in the same clock
    // the row already publishes as updatedAt, and monotonic for the pane.
    // The origin tag is the point: `entryState` above collapses a title-derived IDLE or
    // UNREPORTED row to 'working' while the row itself reports idle/unreported. That contradiction is out of scope here —
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

function titleStatusToRowState(status: AgentTitleActivity): AgentRowState {
  switch (status) {
    case 'permission':
      return 'waiting'
    case 'working':
    case 'idle':
    case 'unreported':
      return status
  }
}

function titleActivitySecondaryText(status: AgentTitleActivity): string {
  switch (status) {
    case 'permission':
      return 'Needs input'
    case 'working':
      return 'Running'
    case 'idle':
      return 'Idle'
    case 'unreported':
      return agentNoStatusReportedLabel()
  }
}

/**
 * Resolves the layout leaf that owns a runtime pane title.
 *
 * `runtimePaneTitlesByTabId` mixes two disjoint id spaces: live PaneManager ids
 * (`>= FIRST_PANE_ID`, allocated in pane-creation order) and the `-(leafIndex + 1)`
 * slots parked tabs mint in `fallbackParkedPaneCandidates`. Neither space is ordered
 * like the layout's in-order leaf traversal, so attributing a title by its position
 * in the slot list lands one pane's status on a sibling's row.
 */
function resolveLeafIdForTitleFallback(args: {
  layout: TerminalLayoutSnapshot | undefined
  leafIds: string[]
  ptyIds: string[]
  liveSlotIds: number[]
  liveSlotsAreDense: boolean
  paneId: number
  title: string
}): string | null {
  if (args.leafIds.length === 1) {
    return args.leafIds[0]
  }
  if (args.paneId < FIRST_PANE_ID) {
    // Parked slots are defined off the in-order leaf list, so invert that definition.
    return args.leafIds[-args.paneId - 1] ?? null
  }
  if (args.liveSlotsAreDense) {
    const creationOrderLeafId = resolveRuntimePaneTitleLeafIdFromRoot(
      args.layout?.root,
      String(args.paneId)
    )
    if (creationOrderLeafId) {
      return creationOrderLeafId
    }
  }

  // After an in-session close, PaneManager ids are sparse while the tab's live
  // PTYs retain their relative order. Use the durable PTY-to-leaf bindings to
  // recover the exact leaf instead of assigning a survivor by layout position.
  const ptyBoundLeafId = resolveRuntimePaneTitleLeafIdFromSparseSlots({
    layout: args.layout,
    paneId: args.paneId,
    liveSlotIds: args.liveSlotIds,
    ptyIds: args.ptyIds
  })
  if (ptyBoundLeafId) {
    return ptyBoundLeafId
  }

  const matchingTitleLeafIds = Object.entries(args.layout?.titlesByLeafId ?? {})
    .filter(([, title]) => title === args.title)
    .map(([leafId]) => leafId)
  if (matchingTitleLeafIds.length === 1) {
    return matchingTitleLeafIds[0]
  }

  // Why: in-session pane closes leave the survivors' ids sparse, which creation order
  // cannot resolve. Index within the LIVE slots only — never across both id spaces.
  const paneIndex = args.liveSlotIds.indexOf(args.paneId)
  return paneIndex !== -1 ? (args.leafIds[paneIndex] ?? null) : null
}
