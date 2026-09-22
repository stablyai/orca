import { Checkbox } from './ui/checkbox'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { translate } from '@/i18n/i18n'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

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
 */
export function ResumeCandidateRow({
  candidate,
  workspaceName,
  listedAt,
  checked,
  disabled,
  onCheckedChange
}: {
  candidate: ResumeCandidate
  /** Named in the checkbox's accessible name: several rows otherwise read identically. */
  workspaceName: string
  listedAt: number
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  const agentLabel = formatAgentTypeLabel(candidate.agent)
  const title =
    candidate.latestPrompt.trim() ||
    translate('auto.components.NativeChatResumeOnRestartModal.untitled', 'Untitled chat')
  const model = candidate.model?.trim() ?? ''
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-accent/50">
        {/* Identifies the agent AND its workspace: the accessible name has to distinguish rows that
            would otherwise all read the same. */}
        <Checkbox
          checked={checked}
          disabled={disabled}
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
    </li>
  )
}
