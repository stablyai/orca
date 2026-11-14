import type { AppState } from '@/store/types'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import { isStructuredTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentMessageTarget } from './agent-message-target'
import { detectAgentSendTitleStatus } from './agent-send-title-status'
import { resolveRuntimePaneTitleLeafResolution } from '../../../../../shared/runtime-pane-title-leaf-id'

export type RunningAgentTargetState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
> &
  Partial<Pick<AppState, 'runtimePaneTitlesByTabId'>>

type RunningAgentSendTargetEligibility = {
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

export type TerminalAgentSendTarget = RunningAgentSendTargetEligibility & {
  kind: 'terminal'
  paneKey: string
  tabId: string
  leafId: string
  tab: TerminalTab
  entry: AgentStatusEntry
  ptyId: string | null
}

export type StructuredAgentSendTarget = RunningAgentSendTargetEligibility & {
  kind: 'structured-session'
  paneKey: string
  /** The chat's workspace tab; it never appears in `tabsByWorktree`. */
  tabId: string
  sessionId: string
  agentType: AgentType
  title: string
  /** Null before the chat's first turn (the host publishes no status before one); only the
   *  notes menu lists such chats, as the sidebar has no row for them. */
  entry: AgentStatusEntry | null
}

export type RunningAgentSendTarget = TerminalAgentSendTarget | StructuredAgentSendTarget

export function runningAgentMessageTarget(target: RunningAgentSendTarget): AgentMessageTarget {
  return target.kind === 'terminal'
    ? { kind: 'terminal', tabId: target.tabId, leafId: target.leafId }
    : { kind: 'structured-session', sessionId: target.sessionId }
}

export function runningAgentSendTargetAgentType(
  target: RunningAgentSendTarget
): AgentType | null | undefined {
  return target.kind === 'terminal' ? target.entry.agentType : target.agentType
}

export function deriveRunningAgentSendTargets(
  state: RunningAgentTargetState,
  worktreeId: string
): RunningAgentSendTarget[] {
  return [
    ...deriveTerminalAgentSendTargets(state, worktreeId),
    ...deriveStructuredAgentSendTargets(state, worktreeId, 'with-status')
  ]
}

/** Chats of the worktree that have not had their first turn yet, so no status entry exists. */
export function deriveStatuslessStructuredAgentSendTargets(
  state: RunningAgentTargetState,
  worktreeId: string
): StructuredAgentSendTarget[] {
  return deriveStructuredAgentSendTargets(state, worktreeId, 'without-status')
}

function deriveTerminalAgentSendTargets(
  state: RunningAgentTargetState,
  worktreeId: string
): TerminalAgentSendTarget[] {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  if (tabs.length === 0) {
    return []
  }

  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  const targets: TerminalAgentSendTarget[] = []

  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const tab = tabsById.get(parsed.tabId)
    if (!tab) {
      continue
    }

    const layoutPtyId =
      state.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId] ?? null
    const ptyId =
      layoutPtyId && state.ptyIdsByTabId?.[parsed.tabId]?.includes(layoutPtyId) ? layoutPtyId : null
    let disabledReason: string | undefined

    // Idle agents emit no hooks, so row age never disables a live pane; the host's process/screen check gates the send.
    const liveTitleStatus = ptyId
      ? detectLiveAgentPaneStatus(state, parsed.tabId, parsed.leafId, tab.title)
      : null
    // An unanswered prompt sends no further hooks and idle titles can persist under open dialogs, so only the agent's next report clears it.
    if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
    } else if (
      entry.state === 'blocked' ||
      entry.state === 'waiting' ||
      liveTitleStatus === 'permission'
    ) {
      disabledReason = 'Agent needs permission'
    }

    targets.push({
      kind: 'terminal',
      paneKey,
      tabId: parsed.tabId,
      leafId: parsed.leafId,
      tab,
      entry,
      ptyId,
      status: disabledReason ? 'disabled' : 'eligible',
      ...(disabledReason ? { disabledReason } : {})
    })
  }

  return targets
}

// Chats have workspace tabs without PTYs; list only those with status because sidebar reveal/visibility/pills require a row. Notes separately exposes first-turn chats.
function deriveStructuredAgentSendTargets(
  state: RunningAgentTargetState,
  worktreeId: string,
  status: 'with-status' | 'without-status'
): StructuredAgentSendTarget[] {
  const targets: StructuredAgentSendTarget[] = []
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (!isStructuredTab(tab) || !tab.agentSessionAgent) {
      continue
    }
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    const entry = state.agentStatusByPaneKey[paneKey] ?? null
    if ((entry !== null) !== (status === 'with-status')) {
      continue
    }
    const disabledReason =
      entry?.state === 'blocked' || entry?.state === 'waiting'
        ? 'Agent needs permission'
        : undefined
    targets.push({
      kind: 'structured-session',
      paneKey,
      tabId: tab.id,
      sessionId: tab.entityId,
      agentType: tab.agentSessionAgent,
      title: tab.customLabel?.trim() || tab.label,
      entry,
      status: disabledReason ? 'disabled' : 'eligible',
      ...(disabledReason ? { disabledReason } : {})
    })
  }
  return targets
}

function detectLiveAgentPaneStatus(
  state: RunningAgentTargetState,
  tabId: string,
  leafId: string,
  tabTitle: string
): ReturnType<typeof detectAgentSendTitleStatus> {
  const layout = state.terminalLayoutsByTabId[tabId]
  const paneTitles = state.runtimePaneTitlesByTabId?.[tabId]
  const paneTitleResolution = resolveRuntimePaneTitleLeafResolution(layout, paneTitles, leafId)
  // The tab title is the active surface's; it belongs to this leaf only when the tab has no split.
  const tabTitleIsLeafs =
    !paneTitleResolution.hasAnyPaneTitle && (!layout?.root || layout.root.type === 'leaf')
  const title = paneTitleResolution.title ?? (tabTitleIsLeafs ? tabTitle : null)
  if (title === null) {
    return null
  }
  return detectAgentSendTitleStatus(title)
}

export function resolveRunningAgentSendTarget(
  state: RunningAgentTargetState,
  worktreeId: string,
  paneKey: string
): RunningAgentSendTarget | null {
  return deriveRunningAgentSendTargets(state, worktreeId).find((t) => t.paneKey === paneKey) ?? null
}
