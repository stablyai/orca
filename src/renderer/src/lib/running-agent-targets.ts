import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentType } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { isStructuredTab } from '@/components/native-chat/structured-agent-session-tabs'
import { resolvePaneAgentActivity } from '@/lib/pane-agent-evidence'
import type { AgentMessageTarget } from './agent-message-target'
import { detectAgentSendTitleStatus } from './agent-send-title-status'
import { resolveRuntimePaneTitleLeafResolution } from './runtime-pane-title-leaf-id'

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
  worktreeId: string,
  now = Date.now()
): RunningAgentSendTarget[] {
  return [
    ...deriveTerminalAgentSendTargets(state, worktreeId, now),
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
  worktreeId: string,
  now: number
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
    const tabPtyIds = state.ptyIdsByTabId?.[parsed.tabId]
    const ptyId =
      layoutPtyId && (tabPtyIds === undefined || tabPtyIds.includes(layoutPtyId))
        ? layoutPtyId
        : null
    let disabledReason: string | undefined

    // Why: the shared resolver gates hook freshness; a null hookState means the
    // entry is stale (entries here always exist), and otherwise carries the
    // fresh entry.state. The live-title layer stays local because it needs the
    // send-gated detector (label + strict idle-send gate), which the resolver's
    // raw titleStatus does not reproduce.
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry,
      liveTitle: null,
      hasLivePty: ptyId !== null,
      now
    })
    // Why: hook-backed rows can go stale while the same PTY is still a live
    // agent; live titles are the runtime proof that the row remains targetable.
    const liveTitleStatus = ptyId
      ? detectLiveAgentPaneStatus(state, parsed.tabId, parsed.leafId, tab.title)
      : null
    if (entry.restoredUnconfirmed) {
      disabledReason = 'Agent status is stale'
    } else if (decision.hookState === null) {
      if (liveTitleStatus === 'permission') {
        disabledReason = 'Agent needs permission'
      } else if (liveTitleStatus === null) {
        disabledReason = 'Agent status is stale'
      }
    } else if (!ptyId) {
      disabledReason = 'Terminal is no longer available'
    } else if (decision.hookState === 'blocked' || decision.hookState === 'waiting') {
      disabledReason = 'Agent needs permission'
    } else if (liveTitleStatus === 'permission') {
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

// Why: a structured chat is a workspace tab with no PTY, so it is listed from the tab itself.
// Chats without status stay out of the shared list, like status-less terminals: every sidebar
// consumer of it (reveal, force-visible, row pills) needs a row to point at.
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
      // Why: false matches the tab strip, which labels a chat tab customLabel ?? label.
      title: resolveUnifiedTabLabel(tab, false),
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
  // Why: runtime pane titles are the freshest title signal for split panes; use
  // the tab title only before the runtime has reported a pane title for the leaf.
  const title = paneTitleResolution.title ?? (paneTitleResolution.hasAnyPaneTitle ? null : tabTitle)
  if (title === null) {
    return null
  }
  return detectAgentSendTitleStatus(title)
}

export function resolveRunningAgentSendTarget(
  state: RunningAgentTargetState,
  worktreeId: string,
  paneKey: string,
  now = Date.now()
): RunningAgentSendTarget | null {
  return (
    deriveRunningAgentSendTargets(state, worktreeId, now).find((t) => t.paneKey === paneKey) ?? null
  )
}
