import type { AgentType } from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/types'
import { detectAgentSendTitleStatus } from './agent-send-title-status'
import {
  resolveRuntimePaneTitleLeafResolution,
  type RuntimePaneTitleLeafResolution
} from './runtime-pane-title-leaf-id'
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

function detectLaunchAgentPaneStatus(
  paneTitleResolution: RuntimePaneTitleLeafResolution,
  tabTitle: string
) {
  if (paneTitleResolution.title !== null) {
    return detectAgentSendTitleStatus(paneTitleResolution.title)
  }
  // Why: mirror isTerminalRunningAgent — the OSC-enriched tab title only counts
  // when the leaf has no runtime pane title of its own yet.
  if (paneTitleResolution.hasAnyPaneTitle) {
    return null
  }
  return detectAgentSendTitleStatus(tabTitle)
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
      agentType: resolveNotesTargetAgentType(target.entry.agentType, target.tab.launchAgent),
      tabTitle: target.tab.title,
      status: target.status,
      ...(target.disabledReason ? { disabledReason: target.disabledReason } : {})
    })
  )

  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const launchTarget = deriveLaunchAgentTarget(state, tab)
    if (!launchTarget) {
      continue
    }

    mergeLaunchAgentTarget(targets, launchTarget)
  }

  return targets
}

function resolveNotesTargetAgentType(
  entryAgentType: AgentType | null | undefined,
  launchAgent: AgentType | null | undefined
): AgentType | null | undefined {
  if (entryAgentType && entryAgentType !== 'unknown') {
    return entryAgentType
  }
  return launchAgent ?? entryAgentType
}

function deriveLaunchAgentTarget(
  state: NotesSendAgentTargetState,
  tab: TerminalTab
): NotesSendAgentTarget | null {
  if (!tab.launchAgent) {
    return null
  }

  const layout = state.terminalLayoutsByTabId[tab.id]
  const leafId = layout?.activeLeafId
  if (!leafId || !isTerminalLeafId(leafId)) {
    return null
  }

  const ptyId = layout.ptyIdsByLeafId?.[leafId] ?? null
  if (!ptyId || !state.ptyIdsByTabId[tab.id]?.includes(ptyId)) {
    return null
  }

  const paneTitles = state.runtimePaneTitlesByTabId[tab.id]
  const paneTitleResolution = resolveRuntimePaneTitleLeafResolution(layout, paneTitles, leafId)
  const launchStatus = detectLaunchAgentPaneStatus(paneTitleResolution, tab.title)
  if (!launchStatus) {
    // Why: launchAgent is set the instant Orca spawns the tab, but the runtime
    // only accepts a send once the pane reads as an agent. Skipping until the
    // title is recognized keeps "listed ⇒ sendable" and avoids the boot-window
    // "not a recognized agent session" error.
    return null
  }
  const disabledReason = launchStatus === 'permission' ? 'Agent needs permission' : undefined

  return {
    paneKey: makePaneKey(tab.id, leafId),
    tabId: tab.id,
    leafId,
    agentType: tab.launchAgent,
    tabTitle: tab.title,
    status: disabledReason ? 'disabled' : 'eligible',
    ...(disabledReason ? { disabledReason } : {})
  }
}

function mergeLaunchAgentTarget(
  targets: NotesSendAgentTarget[],
  launchTarget: NotesSendAgentTarget
): void {
  const samePaneIndex = targets.findIndex((target) => target.paneKey === launchTarget.paneKey)
  if (samePaneIndex !== -1) {
    const existing = targets[samePaneIndex]
    if (existing.status === 'eligible' || existing.disabledReason === 'Agent needs permission') {
      return
    }

    // Why: hook-backed status can outlive the CLI after sleep/resume. When the
    // same live launch-agent pane has a fresh title proof, prefer the sendable
    // runtime evidence over the stale retained status row.
    targets[samePaneIndex] = {
      ...launchTarget,
      agentType:
        existing.agentType && existing.agentType !== 'unknown'
          ? existing.agentType
          : launchTarget.agentType,
      tabTitle: existing.tabTitle || launchTarget.tabTitle
    }
    return
  }

  // Why: dedupe by tab for fresh/permission status rows. Their active leaf may
  // be a split shell pane, which would list a second bogus row for the same tab.
  if (
    targets.some(
      (target) =>
        target.tabId === launchTarget.tabId &&
        (target.status === 'eligible' || target.disabledReason === 'Agent needs permission')
    )
  ) {
    return
  }

  targets.push(launchTarget)
}
