import type { AgentType } from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { detectAgentStatusFromTitle, getAgentLabel } from './agent-status'
import { resolveRuntimePaneTitleForLeaf } from './runtime-pane-title-leaf-id'
import {
  deriveRunningAgentSendTargets,
  type RunningAgentTargetState
} from './running-agent-targets'

export type NotesSendAgentTargetState = RunningAgentTargetState &
  Pick<AppState, 'runtimePaneTitlesByTabId'>

export type NotesSendAgentTarget = {
  paneKey: string
  tabId: string
  leafId: string
  agentType: AgentType | null | undefined
  tabTitle: string
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

function isRecognizedAgentTitle(title: string | null): boolean {
  return (
    title !== null && detectAgentStatusFromTitle(title) !== null && getAgentLabel(title) !== null
  )
}

function launchAgentPaneLooksRecognized(paneTitle: string | null, tabTitle: string): boolean {
  if (isRecognizedAgentTitle(paneTitle)) {
    return true
  }
  // Why: mirror isTerminalRunningAgent — the OSC-enriched tab title only counts
  // when the leaf has no runtime pane title of its own yet.
  return paneTitle === null && isRecognizedAgentTitle(tabTitle)
}

/**
 * Agents of a worktree the notes dropdown can target.
 *
 * Why this exists on top of deriveRunningAgentSendTargets: that derivation only
 * sees panes with a live status entry, so a freshly launched (still idle) agent
 * stays invisible until its first hook event — i.e. until the user talks to it.
 * We augment it with launch-agent tabs whose pane still has a live PTY:
 * TerminalTab.launchAgent records the harness Orca started and is the same
 * pre-hook signal the tab bar already trusts for its provider icon.
 *
 * The launch hint is gated on a recognized agent title (pane or tab) — the same
 * signal isTerminalRunningAgent checks — so a freshly spawned tab is only listed
 * once the runtime would actually accept the send. Without that gate, clicking a
 * still-booting pane fails with "not a recognized agent session".
 */
export function deriveNotesSendAgentTargets(
  state: NotesSendAgentTargetState,
  worktreeId: string,
  now = Date.now()
): NotesSendAgentTarget[] {
  const targets: NotesSendAgentTarget[] = deriveRunningAgentSendTargets(state, worktreeId, now).map(
    (target) => ({
      paneKey: target.paneKey,
      tabId: target.tabId,
      leafId: target.leafId,
      agentType: target.entry.agentType,
      tabTitle: target.tab.title,
      status: target.status,
      ...(target.disabledReason ? { disabledReason: target.disabledReason } : {})
    })
  )

  // Why: dedupe by tab, not pane. A launch-agent tab already surfaced through a
  // live status entry must not also emit a hint row — its active leaf may be a
  // split shell pane, which would list a second bogus row for the same tab.
  const statusBackedTabIds = new Set(targets.map((target) => target.tabId))

  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    if (!tab.launchAgent || statusBackedTabIds.has(tab.id)) {
      continue
    }

    const layout = state.terminalLayoutsByTabId[tab.id]
    const leafId = layout?.activeLeafId
    if (!leafId || !isTerminalLeafId(leafId)) {
      continue
    }

    const ptyId = layout.ptyIdsByLeafId?.[leafId] ?? null
    if (!ptyId || !state.ptyIdsByTabId[tab.id]?.includes(ptyId)) {
      continue
    }

    const paneTitle = resolveRuntimePaneTitleForLeaf(
      layout,
      state.runtimePaneTitlesByTabId[tab.id],
      leafId
    )
    if (!launchAgentPaneLooksRecognized(paneTitle, tab.title)) {
      // Why: launchAgent is set the instant Orca spawns the tab, but the runtime
      // only accepts a send once the pane reads as an agent. Skipping until the
      // title is recognized keeps "listed ⇒ sendable" and avoids the boot-window
      // "not a recognized agent session" error.
      continue
    }

    targets.push({
      paneKey: makePaneKey(tab.id, leafId),
      tabId: tab.id,
      leafId,
      agentType: tab.launchAgent,
      tabTitle: tab.title,
      status: 'eligible'
    })
  }

  return targets
}
