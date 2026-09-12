import type {
  AgentStateHistoryEntry,
  AgentStatusEntry,
  AgentStatusState
} from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getAgentRowPrimaryText,
  isOrcaDispatchPrompt,
  orchestrationLabelsMatchLiveDispatch
} from './agent-row-primary-text'
import { formatAgentToolPreview } from './agent-row-tool-preview'

// Why: follow-up replies ("yes", "ok proceed") are valid hook prompts but are
// terrible scan labels for a cross-worktree agent list — treat them as non-titles.
const TERSE_FOLLOW_UP_PATTERN =
  /^(yes|no|ok|yep|nope|sure|thanks|thank you|please|proceed|continue|go ahead|lgtm|done|looks good|ok proceed|hi|hey|hello|yo)\.?$/i

export function isTerseAgentFollowUpPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed) {
    return true
  }
  if (trimmed.length > 24) {
    return false
  }
  return TERSE_FOLLOW_UP_PATTERN.test(trimmed)
}

function taskTitleFromPrompt(prompt: string): string | null {
  if (isOrcaDispatchPrompt(prompt)) {
    const preview = getAgentRowPrimaryText({ prompt })
    return preview || null
  }
  const trimmed = prompt.trim()
  if (!trimmed || isTerseAgentFollowUpPrompt(trimmed)) {
    return null
  }
  return trimmed
}

function bestTaskPromptFromHistory(history: readonly AgentStateHistoryEntry[]): string | null {
  // Why: the most recent substantive turn is the current task — older prompts
  // (even longer ones) must not shadow newer work. Compare startedAt rather
  // than array position so out-of-order history still resolves the latest turn.
  let best: string | null = null
  let bestStartedAt = Number.NEGATIVE_INFINITY
  for (const historyEntry of history) {
    const candidate = taskTitleFromPrompt(historyEntry.prompt)
    if (!candidate) {
      continue
    }
    if (historyEntry.startedAt >= bestStartedAt) {
      best = candidate
      bestStartedAt = historyEntry.startedAt
    }
  }
  return best
}

// Why: orchestration labels are the stable identity across follow-up turns, but
// sticky metadata can outlive the task. Trust the label only when it still
// describes the live work: a dispatch turn must share the task id (mirrors
// getAgentRowPrimaryText), and a substantive non-dispatch prompt means the pane
// moved on to new work — a terse follow-up ("yes") is still the same task.
function orchestrationLabelForEntry(
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
): string | null {
  const label =
    entry.orchestration?.displayName?.trim() || entry.orchestration?.taskTitle?.trim() || ''
  if (!label) {
    return null
  }
  if (isOrcaDispatchPrompt(entry.prompt)) {
    return orchestrationLabelsMatchLiveDispatch(entry) ? label : null
  }
  if (taskTitleFromPrompt(entry.prompt)) {
    return null
  }
  return label
}

/** Friendly workspace label — matches the sidebar worktree card's primary name. */
export function getActivityThreadWorkspaceTitle(
  worktree: Pick<Worktree, 'displayName' | 'branch'>
): string {
  const displayName = worktree.displayName?.trim()
  const branch = worktree.branch?.trim()
  if (displayName) {
    return displayName
  }
  return branch || 'Workspace'
}

/** Stable task identity for Activity sidebar rows — not the latest follow-up turn. */
export function getActivityThreadTaskTitle(args: {
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt' | 'stateHistory'>
  tab: Pick<TerminalTab, 'customTitle' | 'generatedTitle' | 'title' | 'defaultTitle'>
  generatedTitlesEnabled: boolean
}): string {
  const customTitle = args.tab.customTitle?.trim()
  if (customTitle) {
    return customTitle
  }

  const orchestrationLabel = orchestrationLabelForEntry(args.entry)
  if (orchestrationLabel) {
    return orchestrationLabel
  }

  // Why: respect the user's tabAutoGenerateTitle setting — a disabled generated
  // title must not resurface here (mirrors resolveTerminalTabTitle's gate).
  const generatedTitle = args.generatedTitlesEnabled ? args.tab.generatedTitle?.trim() : ''
  if (generatedTitle) {
    return generatedTitle
  }

  // Why: a substantive live prompt is genuine new work and must win — the row
  // title follows the active turn (see buildAgentPaneThreads). Only a terse
  // follow-up ("yes") falls through to the prior task recorded in history.
  const liveTitle = taskTitleFromPrompt(args.entry.prompt)
  if (liveTitle) {
    return liveTitle
  }

  const historical = bestTaskPromptFromHistory(args.entry.stateHistory)
  if (historical) {
    return historical
  }

  const liveTabTitle = args.tab.title?.trim()
  const defaultTabTitle = args.tab.defaultTitle?.trim()
  if (liveTabTitle && liveTabTitle !== defaultTabTitle) {
    return liveTabTitle
  }
  return defaultTabTitle || liveTabTitle || 'Terminal'
}

function isMislabeledUserPrompt(text: string, entry: Pick<AgentStatusEntry, 'prompt'>): boolean {
  const trimmed = text.trim()
  if (!trimmed) {
    return true
  }
  if (isTerseAgentFollowUpPrompt(trimmed)) {
    return true
  }
  // Why: some hooks echo the live user prompt into assistant preview fields
  // between turns; never surface that as the agent's latest reply.
  if (trimmed === entry.prompt.trim()) {
    return true
  }
  return false
}

// Why: orchestration workers often start the stop-hook preview with the
// lifecycle report ("Task complete — worker_done sent") so a 2-line card
// never reaches the actual reply. Match `worker_done sent` near the start
// rather than a single dash shape — agents use em dashes, `--`, or markdown.
const WORKER_DONE_SENT = /\bworker_done sent(?:\s+with outcome \w+)?/i
const ORCHESTRATION_SUMMARY_PREFIX = /^(?:\*{0,2})summary of what happened:\s*/i
const ORCHESTRATION_VERDICT_PREFIX = /^(?:\*{0,2})verdict:(?:\*{0,2})\s*/i

function unwrapOrchestrationAssistantPreview(text: string): string {
  let next = text.trim()
  const workerDone = WORKER_DONE_SENT.exec(next)
  if (workerDone && workerDone.index < 96) {
    next = next.slice(workerDone.index + workerDone[0].length).replace(/^[.\s…*—–-]+/, '')
  }
  next = next.replace(ORCHESTRATION_SUMMARY_PREFIX, '').trim()
  next = next.replace(ORCHESTRATION_VERDICT_PREFIX, '').trim()
  return next
}

function usefulAssistantReply(text: string, entry: Pick<AgentStatusEntry, 'prompt'>): string {
  const trimmed = text.trim()
  if (!trimmed || isMislabeledUserPrompt(trimmed, entry)) {
    return ''
  }
  const unwrapped = unwrapOrchestrationAssistantPreview(trimmed)
  if (!unwrapped || /^[.\s…]+$/.test(unwrapped) || isMislabeledUserPrompt(unwrapped, entry)) {
    return ''
  }
  return unwrapped
}

/** Latest agent activity line — tool step while working, assistant reply otherwise. */
export function getActivityThreadStatusPreview(
  entry: Pick<
    AgentStatusEntry,
    | 'state'
    | 'toolName'
    | 'toolInput'
    | 'lastAssistantMessage'
    | 'lastCompletedAssistantMessage'
    | 'interrupted'
    | 'prompt'
  >,
  agentState?: AgentStatusState | null
): string {
  if (entry.interrupted === true) {
    return 'Interrupted by user'
  }
  const state = agentState ?? entry.state
  const toolPreview = formatAgentToolPreview(entry, state)
  if (toolPreview) {
    return toolPreview
  }
  const assistant = usefulAssistantReply(entry.lastAssistantMessage ?? '', entry)
  if (assistant) {
    return assistant
  }
  // Why: live working/waiting pings clear lastAssistantMessage; the completed-turn
  // snapshot is the last useful reply once the agent is no longer in-flight.
  if (state !== 'working' && state !== 'waiting') {
    return usefulAssistantReply(entry.lastCompletedAssistantMessage ?? '', entry)
  }
  return ''
}

/** Keep the last good assistant preview when a new hook ping clears or mislabels it. */
export function resolveActivityThreadStatusPreview(
  entry: Pick<
    AgentStatusEntry,
    | 'state'
    | 'toolName'
    | 'toolInput'
    | 'lastAssistantMessage'
    | 'lastCompletedAssistantMessage'
    | 'interrupted'
    | 'prompt'
  >,
  agentState: AgentStatusState | null | undefined,
  previousPreview?: string
): string {
  const next = getActivityThreadStatusPreview(entry, agentState)
  if (next) {
    return next
  }
  // Why: only bridge a transient empty/mislabeled ping within the SAME turn. A
  // substantive live prompt marks a new turn, so the prior turn's reply must not
  // linger as the current status (a fresh working turn shows no stale preview).
  if (!isTerseAgentFollowUpPrompt(entry.prompt)) {
    return ''
  }
  return usefulAssistantReply(previousPreview ?? '', entry)
}
