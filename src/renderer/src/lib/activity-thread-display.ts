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
} from '../../../shared/agent-row-primary-text'
import { formatAgentToolPreview } from './agent-row-tool-preview'
import { agentVerdictStatusLine } from './agent-verdict-status-line'

// Terse follow-ups such as “yes” are valid prompts but poor cross-worktree task labels.
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
  // Use the newest substantive startedAt, independent of array order; older lengthy prompts must not shadow new work.
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

// Keep orchestration labels only for the same dispatch task or terse follow-up; substantive new prompts retire sticky labels.
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

  // Respect tabAutoGenerateTitle here too so disabled generated titles cannot resurface.
  const generatedTitle = args.generatedTitlesEnabled ? args.tab.generatedTitle?.trim() : ''
  if (generatedTitle) {
    return generatedTitle
  }

  // Substantive live prompts win; only terse follow-ups reuse the prior task’s history label.
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
  // Hooks can echo the user prompt into preview fields; never show it as the agent’s reply.
  if (trimmed === entry.prompt.trim()) {
    return true
  }
  return false
}

// Skip a leading worker_done lifecycle report so two-line previews reach the reply; tolerate varied dash/Markdown forms.
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

export function getActivityThreadStatusPreview(
  entry: Pick<
    AgentStatusEntry,
    | 'state'
    | 'toolName'
    | 'toolInput'
    | 'lastAssistantMessage'
    | 'lastCompletedAssistantMessage'
    | 'interrupted'
    | 'mainAgent'
    | 'prompt'
  >,
  agentState?: AgentStatusState | null
): string {
  const verdictLine = agentVerdictStatusLine(entry)
  if (verdictLine) {
    return verdictLine
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
  // Working/waiting pings clear lastAssistantMessage; the completed-turn snapshot retains the last useful reply.
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
    | 'mainAgent'
    | 'prompt'
  >,
  agentState: AgentStatusState | null | undefined,
  previousPreview?: string
): string {
  const next = getActivityThreadStatusPreview(entry, agentState)
  if (next) {
    return next
  }
  // Bridge empty/mislabeled pings only within the same turn; a substantive new prompt must not inherit a stale reply.
  if (!isTerseAgentFollowUpPrompt(entry.prompt)) {
    return ''
  }
  return usefulAssistantReply(previousPreview ?? '', entry)
}
