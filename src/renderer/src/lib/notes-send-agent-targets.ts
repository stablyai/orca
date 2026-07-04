import type { AgentType } from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
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

type AgentTitleEvidence = {
  status: NonNullable<ReturnType<typeof detectAgentSendTitleStatus>>
  title: string
}

function detectTitleHintPaneEvidence(
  paneTitleResolution: RuntimePaneTitleLeafResolution,
  tabTitle: string
): AgentTitleEvidence | null {
  if (paneTitleResolution.title !== null) {
    const status = detectAgentSendTitleStatus(paneTitleResolution.title)
    return status ? { status, title: paneTitleResolution.title } : null
  }
  // Why: mirror isTerminalRunningAgent — the OSC-enriched tab title only counts
  // when the leaf has no runtime pane title of its own yet.
  if (paneTitleResolution.hasAnyPaneTitle) {
    return null
  }
  const status = detectAgentSendTitleStatus(tabTitle)
  return status ? { status, title: tabTitle } : null
}

/**
 * Agents of a worktree the notes dropdown can target.
 *
 * Why this exists on top of deriveRunningAgentSendTargets: that derivation only
 * sees panes with a live status entry, so a freshly launched (still idle) agent
 * stays invisible until its first hook event — i.e. until the user talks to it.
 * We augment it with recognized agent-title tabs whose pane still has a live
 * PTY. TerminalTab.launchAgent records the harness Orca started; manually typed
 * CLIs do not have that owner bit, so their runtime title is the only pre-hook
 * signal available.
 *
 * The title hint is gated on a recognized agent title (pane or tab) — the same
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
    const titleHintTarget = deriveTitleHintAgentTarget(state, tab)
    if (!titleHintTarget) {
      continue
    }

    // Why: a launchAgent tab carries an owner bit, so its live title can promote a
    // stale status row on the same pane. A manually started CLI has no owner bit,
    // so it only ever adds a row and must not override existing status evidence.
    if (tab.launchAgent) {
      mergeLaunchAgentTitleTarget(targets, titleHintTarget)
    } else {
      mergeManualAgentTitleTarget(targets, titleHintTarget)
    }
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

function deriveTitleHintAgentTarget(
  state: NotesSendAgentTargetState,
  tab: TerminalTab
): NotesSendAgentTarget | null {
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
  const titleEvidence = detectTitleHintPaneEvidence(paneTitleResolution, tab.title)
  if (!titleEvidence) {
    // Why: launchAgent is set the instant Orca spawns the tab, but the runtime
    // only accepts a send once the pane reads as an agent; manually started
    // CLIs need the same title proof before appearing in the send menu.
    return null
  }
  const disabledReason =
    titleEvidence.status === 'permission' ? 'Agent needs permission' : undefined

  return {
    paneKey: makePaneKey(tab.id, leafId),
    tabId: tab.id,
    leafId,
    agentType: tab.launchAgent ?? resolveTerminalTitleAgentType(titleEvidence.title),
    tabTitle: tab.title,
    status: disabledReason ? 'disabled' : 'eligible',
    ...(disabledReason ? { disabledReason } : {})
  }
}

// Why: a manual title hint is the weakest signal, so never duplicate a tab that
// already has a status-backed or launch-agent row — even a disabled one.
function mergeManualAgentTitleTarget(
  targets: NotesSendAgentTarget[],
  target: NotesSendAgentTarget
): void {
  if (targets.some((existing) => existing.tabId === target.tabId)) {
    return
  }
  targets.push(target)
}

function mergeLaunchAgentTitleTarget(
  targets: NotesSendAgentTarget[],
  target: NotesSendAgentTarget
): void {
  const samePaneIndex = targets.findIndex((existing) => existing.paneKey === target.paneKey)
  if (samePaneIndex !== -1) {
    const existing = targets[samePaneIndex]
    if (existing.status === 'eligible' || existing.disabledReason === 'Agent needs permission') {
      return
    }

    // Why: hook-backed status can outlive the CLI after sleep/resume. When the
    // same live launch-agent pane has a fresh title proof, prefer the sendable
    // runtime evidence over the stale retained status row.
    targets[samePaneIndex] = {
      ...target,
      agentType:
        existing.agentType && existing.agentType !== 'unknown'
          ? existing.agentType
          : target.agentType,
      tabTitle: existing.tabTitle || target.tabTitle
    }
    return
  }

  // Why: dedupe by tab for fresh/permission status rows. Their active leaf may
  // be a split shell pane, which would list a second bogus row for the same tab.
  if (
    targets.some(
      (existing) =>
        existing.tabId === target.tabId &&
        (existing.status === 'eligible' || existing.disabledReason === 'Agent needs permission')
    )
  ) {
    return
  }

  targets.push(target)
}
