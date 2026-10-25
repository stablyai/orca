import { useContext } from 'react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { translate } from '@/i18n/i18n'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'
import { ResumeFailureGuidanceLine, ResumeFailureStatus } from './NativeChatResumeFailureDetails'
import { resumeActivityLabel } from './native-chat-resume-activity-label'
import { ResumeTreeRow } from './NativeChatResumeTreeRow'
import { ResumeTreeDepthContext } from './native-chat-resume-tree-state'

/**
 * One offered chat as a leaf of the resume tree: its checkbox in the list's shared left column, then,
 * indented for its depth, the provider glyph, "name - what it was doing", the model and an age —
 * the pieces of the sidebar's compact agent row.
 *
 * The sidebar's own `CompactAgentRow` cannot be reused — it takes a `DashboardAgentRow`, which
 * requires a live pane, tab and status entry, and every chat here is by definition stopped. The
 * pieces that do NOT need a live session are reused directly: `AgentIcon`, `agentTypeToIconAgent`,
 * `formatAgentTypeLabel`, `formatShortTimeAgo`, and the same model treatment (monospace, truncated,
 * hidden when empty).
 *
 * No state dot, deliberately. Every `AgentDotState` would mislead: `idle` and `unverifiable` both
 * presuppose a live pane, `interrupted` claims a stop or a newer message ended the turn, `failed`
 * a fault, `done` a finish, `working` a spinner. A missing dot beats a dot that says these agents
 * are running.
 *
 * After the name, what the chat was doing when Orca went away — mid-reply, waiting on the user,
 * subagents or monitoring — so rows the sidebar showed as working for different reasons differ.
 *
 * A chat an earlier resume could not carry on is the same row — selectable where a retry can run,
 * so Resume retries it — plus a status icon, a dismiss control, and a line saying what to do.
 *
 * A leaf of the resume tree; the enclosing workspace node supplies its depth.
 */
export function ResumeCandidateRow({
  candidate,
  workspaceName,
  listedAt,
  checked,
  disabled,
  onCheckedChange,
  failure,
  onFailureAction,
  renderStatus
}: {
  candidate: ResumeCandidate
  /** Named in the checkbox's accessible name: several rows otherwise read identically. */
  workspaceName: string
  listedAt: number
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  /** Present when an earlier resume of this chat did not carry on. */
  failure?: ResumeFailure
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
  renderStatus?: (sessionId: string, title: string) => React.ReactNode
}): React.JSX.Element {
  const agentLabel = formatAgentTypeLabel(candidate.agent)
  const title =
    candidate.latestPrompt.trim() ||
    translate('auto.components.NativeChatResumeOnRestartModal.untitled', 'Untitled chat')
  const model = candidate.model?.trim() ?? ''
  const activity = resumeActivityLabel(candidate.activity)
  const depth = useContext(ResumeTreeDepthContext)
  const status = renderStatus?.(candidate.sessionId, title)
  const act = (action: ResumeFailureAction) => onFailureAction?.(action, candidate.sessionId)
  return (
    <ResumeTreeRow
      depth={depth}
      name={title}
      checked={checked}
      disabled={disabled || (failure !== undefined && !resumeFailureSelectable(failure))}
      onCheckedChange={onCheckedChange}
      // Identifies the agent AND its workspace: rows would otherwise all read the same.
      checkboxLabel={translate(
        'auto.components.NativeChatResumeOnRestartModal.selectAgent',
        'Resume {{value0}} chat "{{value1}}" in {{value2}}',
        { value0: agentLabel, value1: title, value2: workspaceName }
      )}
      compact
      checkboxSlot={status}
      // Outside the label, so pressing them never toggles the checkbox.
      trailing={
        failure &&
        !status && (
          <ResumeFailureStatus
            failure={failure}
            title={title}
            workspaceName={workspaceName}
            disabled={disabled}
            onAction={act}
          />
        )
      }
      below={
        failure &&
        !status && (
          <ResumeFailureGuidanceLine failure={failure} disabled={disabled} onAction={act} />
        )
      }
    >
      {/* AgentIcon carries no label of its own, so the provider was invisible to assistive tech. */}
      <span role="img" aria-label={agentLabel} className="inline-flex shrink-0">
        <AgentIcon agent={agentTypeToIconAgent(candidate.agent)} size={13} />
      </span>
      <span
        className="min-w-0 flex-1 truncate text-xs"
        title={activity ? `${title} - ${activity.detail || activity.summary}` : title}
      >
        <span className="text-foreground/90">{title}</span>
        {activity && <span className="text-muted-foreground"> - {activity.summary}</span>}
      </span>
      {model && (
        <span
          className="min-w-0 max-w-24 shrink-0 truncate font-mono text-[10px] text-muted-foreground"
          title={model}
        >
          {model}
        </span>
      )}
      {/* `formatShortTimeAgo` takes (timestamp, now) and subtracts internally — NOT a delta. */}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatShortTimeAgo(candidate.recordedAt, listedAt)}
      </span>
    </ResumeTreeRow>
  )
}
