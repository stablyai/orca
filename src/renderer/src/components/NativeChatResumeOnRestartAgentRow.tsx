import { Checkbox } from './ui/checkbox'
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

/**
 * One offered chat, laid out like the sidebar's compact agent row: provider glyph, the chat's name,
 * then the model and an age on the right.
 *
 * The sidebar's own `CompactAgentRow` cannot be reused — it takes a `DashboardAgentRow`, which
 * requires a live pane, tab and status entry, and every chat here is by definition stopped. The
 * pieces that do NOT need a live session are reused directly: `AgentIcon`, `agentTypeToIconAgent`,
 * `formatAgentTypeLabel`, `formatShortTimeAgo`, and the same model treatment (monospace, truncated,
 * hidden when empty).
 *
 * No state dot, deliberately. Every `AgentDotState` would mislead: `idle` and `unverifiable` both
 * presuppose a live pane, `interrupted` renders red like an error, `done` green, `working` a
 * spinner. A missing dot beats a dot that says these agents are running.
 *
 * A chat an earlier resume could not carry on is the same row — selectable where a retry can run,
 * so Resume retries it — plus a status icon, a dismiss control, and a line saying what to do.
 */
export function ResumeCandidateRow({
  candidate,
  workspaceName,
  listedAt,
  checked,
  disabled,
  onCheckedChange,
  failure,
  onFailureAction
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
}): React.JSX.Element {
  const agentLabel = formatAgentTypeLabel(candidate.agent)
  const title =
    candidate.latestPrompt.trim() ||
    translate('auto.components.NativeChatResumeOnRestartModal.untitled', 'Untitled chat')
  const model = candidate.model?.trim() ?? ''
  const row = (
    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent/50">
      {/* Identifies the agent AND its workspace: the accessible name has to distinguish rows that
            would otherwise all read the same. */}
      <Checkbox
        checked={checked}
        disabled={disabled || (failure !== undefined && !resumeFailureSelectable(failure))}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="shrink-0"
        aria-label={translate(
          'auto.components.NativeChatResumeOnRestartModal.selectAgent',
          'Resume {{value0}} chat "{{value1}}" in {{value2}}',
          { value0: agentLabel, value1: title, value2: workspaceName }
        )}
      />
      {/* AgentIcon carries no label of its own, so the provider was invisible to assistive tech. */}
      <span role="img" aria-label={agentLabel} className="inline-flex shrink-0">
        <AgentIcon agent={agentTypeToIconAgent(candidate.agent)} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
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
    </label>
  )
  if (!failure) {
    return <li>{row}</li>
  }
  const act = (action: ResumeFailureAction) => onFailureAction?.(action, candidate.sessionId)
  return (
    <li className="flex flex-col">
      {/* Outside the label, so pressing them never toggles the checkbox. */}
      <div className="flex items-center gap-1">
        {row}
        <ResumeFailureStatus
          failure={failure}
          title={title}
          workspaceName={workspaceName}
          disabled={disabled}
          onAction={act}
        />
      </div>
      <ResumeFailureGuidanceLine failure={failure} disabled={disabled} onAction={act} />
    </li>
  )
}
