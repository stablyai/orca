import { agentStateLabel, type AgentDotState } from '@/components/AgentStateDot'
import { formatAgentTypeLabel } from '@/lib/agent-status'
import { getAgentRowPrimaryText } from '@/lib/agent-row-primary-text'
import { showsAgentToolPreview } from '@/lib/agent-row-tool-preview'
import {
  getActivityThreadTaskTitle,
  getActivityThreadWorkspaceTitle,
  resolveActivityThreadStatusPreview
} from '@/lib/activity-thread-display'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'

const ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH = 320

const absoluteDateFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
})

export function formatAbsoluteDate(timestamp: number): string {
  return absoluteDateFormatter.format(new Date(timestamp))
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  return formatUiRelativeTime(timestamp - now)
}

function truncatePreservingSurrogates(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const truncated = value.slice(0, maxLength)
  const lastCode = truncated.charCodeAt(truncated.length - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return truncated.slice(0, -1)
  }
  return truncated
}

export function activityThreadResponseRenderPreview({
  responsePreview
}: {
  responsePreview: string
}): string {
  const trimmed = responsePreview.trim()
  if (trimmed.length <= ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH) {
    return trimmed
  }
  return `${truncatePreservingSurrogates(
    trimmed,
    ACTIVITY_THREAD_RESPONSE_RENDER_PREVIEW_MAX_LENGTH
  ).trimEnd()}...`
}

export function agentTitle(event: ActivityEvent): string {
  if (event.state === 'done') {
    return event.entry.interrupted ? 'Agent interrupted' : 'Agent finished'
  }
  return event.state === 'waiting' ? 'Agent waiting for input' : 'Agent needs input'
}

export function agentSummary(event: ActivityEvent): string {
  const prompt = getAgentRowPrimaryText(event.entry)
  if (event.state === 'done') {
    const message = event.entry.lastAssistantMessage?.trim()
    return message || prompt || 'Completed the current turn.'
  }
  return prompt || event.entry.lastAssistantMessage?.trim() || 'The agent paused for user input.'
}

export function agentMeta(event: ActivityEvent): string {
  const agent = formatAgentTypeLabel(event.agentType)
  if (event.state === 'done') {
    return event.entry.interrupted ? `${agent} interrupted` : `${agent} completed`
  }
  return event.state === 'waiting' ? `${agent} waiting` : `${agent} blocked`
}

// Why: rows need a stable task identity across follow-up turns; the live turn prompt ("yes", "ok proceed") must not replace the task title.
export function paneTitleForEntry(
  entry: AgentStatusEntry,
  tab: TerminalTab,
  generatedTitlesEnabled: boolean
): string {
  return getActivityThreadTaskTitle({ entry, tab, generatedTitlesEnabled })
}

export function paneTitleForEvent(event: ActivityEvent, generatedTitlesEnabled: boolean): string {
  return paneTitleForEntry(event.entry, event.tab, generatedTitlesEnabled)
}

export function statusPreviewForEntry(
  entry: AgentStatusEntry,
  agentState?: AgentStatusState | null,
  previousPreview?: string
): string {
  return resolveActivityThreadStatusPreview(entry, agentState, previousPreview)
}

export function threadAgentState(thread: AgentPaneThread): AgentDotState {
  return thread.currentAgentState ?? thread.latestEvent?.state ?? 'done'
}

export function threadAgentStateLabel(thread: AgentPaneThread): string {
  const state = threadAgentState(thread)
  if (!thread.currentAgentState && state === 'done' && thread.latestEvent?.entry.interrupted) {
    return 'Interrupted'
  }
  return agentStateLabel(state)
}

export type ActivityThreadStatusKind = 'tool' | 'message' | 'state' | 'none'

export type ActivityThreadRowCopy = {
  taskTitle: string
  statusLine: string
  statusKind: ActivityThreadStatusKind
  needsAttention: boolean
  workspaceLabel: string
}

function normalizeScanLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ')
}

function previewDuplicatesIdentity(preview: string, title: string, workspace: string): boolean {
  const normalized = normalizeScanLabel(preview)
  if (!normalized) {
    return true
  }
  return normalized === normalizeScanLabel(title) || normalized === normalizeScanLabel(workspace)
}

export function activityThreadRowCopy(thread: AgentPaneThread): ActivityThreadRowCopy {
  const workspaceLabel = getActivityThreadWorkspaceTitle(thread.worktree)
  const taskTitle = thread.paneTitle.trim() || workspaceLabel
  const renderedPreview = activityThreadResponseRenderPreview({
    responsePreview: thread.responsePreview
  })
  const liveState = thread.currentAgentState ?? thread.latestEvent?.state ?? null
  const toolPreviewState = liveState === 'monitoring' ? null : liveState
  const state = threadAgentState(thread)
  const needsAttention = state === 'waiting' || state === 'blocked' || state === 'permission'
  if (renderedPreview && !previewDuplicatesIdentity(renderedPreview, taskTitle, workspaceLabel)) {
    return {
      taskTitle,
      statusLine: renderedPreview,
      // Monitoring is a distinct live state, not a tool-running row state.
      statusKind: showsAgentToolPreview(toolPreviewState) ? 'tool' : 'message',
      needsAttention,
      workspaceLabel
    }
  }
  if (state !== 'done' && state !== 'idle') {
    return {
      taskTitle,
      statusLine: threadAgentStateLabel(thread),
      statusKind: 'state',
      needsAttention,
      workspaceLabel
    }
  }
  return { taskTitle, statusLine: '', statusKind: 'none', needsAttention, workspaceLabel }
}
