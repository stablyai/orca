import type { AgentType } from '../../../shared/agent-status-types'
import type { AppState } from '@/store/types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { resolveTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { detectAgentSendTitleStatus } from './agent-send-title-status'
import {
  resolveRuntimePaneTitleLeafResolution,
  type RuntimePaneTitleLeafResolution
} from '../../../shared/runtime-pane-title-leaf-id'
import {
  deriveRunningAgentSendTargets,
  deriveStatuslessStructuredAgentSendTargets,
  runningAgentMessageTarget,
  type RunningAgentSendTarget,
  type RunningAgentTargetState
} from './running-agent-targets'
import type { AgentMessageTarget } from './agent-message-target'

export type NotesSendAgentTargetState = RunningAgentTargetState &
  Pick<AppState, 'runtimePaneTitlesByTabId'>

export type NotesSendAgentTarget = {
  paneKey: string
  tabId: string
  messageTarget: AgentMessageTarget
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
  // Use enriched tab title only before the leaf gets its own runtime title, as isTerminalRunningAgent does.
  if (paneTitleResolution.hasAnyPaneTitle) {
    return null
  }
  const status = detectAgentSendTitleStatus(tabTitle)
  return status ? { status, title: tabTitle } : null
}

/** Add live title-backed terminals and first-turn chats that lack hook status. launchAgent gives stronger ownership than manual title hints; hints expose targets only, while runtime independently verifies guarded writes. */
export function deriveNotesSendAgentTargets(
  state: NotesSendAgentTargetState,
  worktreeId: string,
  now = Date.now()
): NotesSendAgentTarget[] {
  const targets: NotesSendAgentTarget[] = [
    ...deriveRunningAgentSendTargets(state, worktreeId, now),
    ...deriveStatuslessStructuredAgentSendTargets(state, worktreeId)
  ].map(toNotesSendAgentTarget)

  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const titleHintTarget = deriveTitleHintAgentTarget(state, tab)
    if (!titleHintTarget) {
      continue
    }

    // Launch ownership permits fresh titles to override stale same-pane status; manual hints may only add missing rows.
    if (tab.launchAgent) {
      mergeLaunchAgentTitleTarget(targets, titleHintTarget)
    } else {
      mergeManualAgentTitleTarget(targets, titleHintTarget)
    }
  }

  return targets
}

function toNotesSendAgentTarget(target: RunningAgentSendTarget): NotesSendAgentTarget {
  return {
    paneKey: target.paneKey,
    tabId: target.tabId,
    messageTarget: runningAgentMessageTarget(target),
    agentType:
      target.kind === 'terminal'
        ? resolveNotesTargetAgentType(target.entry.agentType, target.tab.launchAgent)
        : target.agentType,
    tabTitle: target.kind === 'terminal' ? target.tab.title : target.title,
    status: target.status,
    ...(target.disabledReason ? { disabledReason: target.disabledReason } : {})
  }
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
    // Launch metadata can precede actual TUI startup; require current matching title evidence for discovery.
    return null
  }
  const disabledReason =
    titleEvidence.status === 'permission' ? 'Agent needs permission' : undefined

  return {
    paneKey: makePaneKey(tab.id, leafId),
    tabId: tab.id,
    messageTarget: { kind: 'terminal', tabId: tab.id, leafId },
    agentType: tab.launchAgent ?? resolveTerminalTitleAgentType(titleEvidence.title),
    tabTitle: tab.title,
    status: disabledReason ? 'disabled' : 'eligible',
    ...(disabledReason ? { disabledReason } : {})
  }
}

// Manual hints are weakest; never duplicate status/launch rows, including disabled ones.
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

    // Sleep/resume can leave stale hook status; prefer fresh live-title evidence on the same launch-owned pane.
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

  // Deduplicate fresh/permission rows by tab or an active split shell could create a bogus second target.
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
