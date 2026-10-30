import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { formatAgentTypeLabel, isClaudeManagementTitle } from '@/lib/agent-status'
import { isCursorAgentTitle } from '../../../../shared/agent-title-core'
import { classifyTitleActivity, resolveTitleActivityLabel } from '@/lib/pane-agent-evidence'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'
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
} from '../../../../shared/runtime-pane-title-leaf-id'
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
import { translate } from '@/i18n/i18n'

/** Title snapshots use one restart-stable authority; revisions are comparable only within it, never across authorities. */
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
      // Only dense live IDs retain mount/replay creation order; closing a pane makes IDs sparse.
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

/** Build title-fallback rows while normalizing Pi-compatible names to their owner. */
function buildTitleDerivedAgentRow(args: {
  tab: TerminalTab
  leafId: string
  title: string
  ownerAgentType: AgentType | null
  paneForegroundAgentByPaneKey: Record<string, TitleDerivedPaneForeground>
  now: number
  runtimeAgentOrchestrationByPaneKey?: Record<string, AgentStatusOrchestrationContext>
}): DashboardAgentRow | null {
  // Launch identity normalizes compatible title frames; stricter per-pane ownership below decides identity within splits.
  const title = normalizeCompatibleAgentTitleForOwner(args.title, args.tab.launchAgent, {
    ownerIsLaunch: Boolean(args.tab.launchAgent)
  })
  const isClaudeAgentsTitle = isClaudeManagementTitle(title)
  // Claude management and Cursor’s status-less native titles still identify idle panes without claiming active work.
  const titleStatus = isClaudeAgentsTitle
    ? 'idle'
    : (classifyTitleActivity(title) ?? (isCursorAgentTitle(title) ? 'idle' : null))
  const label = isClaudeAgentsTitle ? 'Claude Code' : resolveTitleActivityLabel(title)
  if (!isTerminalLeafId(args.leafId)) {
    return null
  }
  const paneKey = makePaneKey(args.tab.id, args.leafId)
  const orchestration = args.runtimeAgentOrchestrationByPaneKey?.[paneKey]
  // Status frames prove activity, not ownership; a title-derived identity also needs an agent label.
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
  // Why: the title sets activity only; a plain title on a process-identified pane is idle.
  const status = titleStatus ?? 'idle'
  const rowLabel = agentType === titleAgentType && label ? label : formatAgentTypeLabel(agentType)
  const rowState = titleStatusToRowState(status)
  const secondary =
    status === 'permission'
      ? translate('auto.components.sidebar.titleDerivedAgentRows.needsInput', 'Needs input')
      : status === 'working'
        ? translate('auto.components.sidebar.titleDerivedAgentRows.running', 'Running')
        : translate('auto.components.sidebar.titleDerivedAgentRows.idle', 'Idle')
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
    // Use deterministic clock revisions for rederived snapshots; title origin distinguishes synthetic working entries from idle rows.
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
    // Zero marks title-derived prompts; unread uses store turn records, and freshness-keyed dashboard buckets must not consume synthetic now stamps.
    startedAt: 0
  }
}

function resolveTitleDerivedPaneOwner(
  tab: TerminalTab,
  layout: TerminalLayoutSnapshot | undefined,
  leafId: string
): AgentType | null {
  // Tab-scoped launch ownership applies only to a single leaf; a split must not let one pane brand its sibling.
  if (layout?.root?.type !== 'leaf' || layout.root.leafId !== leafId) {
    return null
  }
  return resolvePaneAgentOwner({ launchAgent: tab.launchAgent })
}

/** Normalize title agent identity to a compatible authoritative owner when supplied. */
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

/** Map negative parked slots by leaf traversal and live IDs by creation/PTY bindings; sorting both together misattributes sibling titles. */
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

  // Sparse IDs after pane closure need durable PTY-to-leaf bindings rather than layout-position guesses.
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

  // Fallback indexing uses only live slots; parked slots belong to a separate ID space.
  const paneIndex = args.liveSlotIds.indexOf(args.paneId)
  return paneIndex !== -1 ? (args.leafIds[paneIndex] ?? null) : null
}
