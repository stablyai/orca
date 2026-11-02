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

/** Render stopped chats with the sidebar’s reusable icon/model/name pieces; CompactAgentRow requires a live pane/tab/status.
 * Omit live-state dots because no state is proven. Failed resumes retain the row with actionable status; the enclosing workspace supplies depth. */
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
      {/* AgentIcon has no label, so name its provider for assistive technology. */}
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
      {/* formatShortTimeAgo takes a timestamp and current time, not a delta. */}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatShortTimeAgo(candidate.recordedAt, listedAt)}
      </span>
    </ResumeTreeRow>
  )
}
