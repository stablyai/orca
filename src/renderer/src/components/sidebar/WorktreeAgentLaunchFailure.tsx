import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { agentLaunchFailureMessage } from '@/lib/agent-launch-failure-copy'
import {
  isDestructiveRecoveryAction,
  recoveryActionLabel
} from '@/lib/agent-launch-recovery-action-copy'
import type {
  AgentLaunchRecoveryActionId,
  AgentLaunchRecoveryCardModel
} from '@/lib/agent-launch-recovery-card'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'

/** Intent-scoped title for a durable unattended launch failure surfaced on the
 *  worktree card. Automation/orchestration/background launches fail while the user
 *  is elsewhere, so the title names the owning record rather than "this workspace".
 *  Interactive/cli/resume launches never reach this surface (they own the
 *  above-terminal recovery card), so they fall to the generic title. */
function unattendedFailureTitle(intent: PersistedAgentLaunchFailure['intent']): string {
  switch (intent) {
    case 'automation':
      return translate(
        'agentLaunch.unattendedFailure.title.automation',
        "An automation's agent didn't start."
      )
    case 'orchestration':
      return translate(
        'agentLaunch.unattendedFailure.title.orchestration',
        "A task's agent didn't start."
      )
    case 'background':
      return translate(
        'agentLaunch.unattendedFailure.title.background',
        "A background agent didn't start."
      )
    case 'cli':
    case 'interactive':
    case 'resume':
      return translate(
        'agentLaunch.unattendedFailure.title.generic',
        "An agent launch didn't finish."
      )
  }
}

/** Compact, presentational unattended agent-launch failure card for the worktree
 *  sidebar. Store/IPC-free: the caller resolves the action model and handles each
 *  action (Forget is owner-authorized and frees one reservation without spawning
 *  or killing a terminal). The failure copy renders from the client-safe failure
 *  code only. The richer code-based recovery lives on the interactive above-terminal
 *  card once the workspace is opened. */
export function WorktreeAgentLaunchFailure({
  failure,
  actions,
  busy = false,
  onAction
}: {
  failure: PersistedAgentLaunchFailure
  actions: AgentLaunchRecoveryCardModel
  busy?: boolean
  onAction: (id: AgentLaunchRecoveryActionId) => void
}): React.JSX.Element {
  const actionIds = [actions.primary, ...actions.secondary]
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 text-card-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 text-xs leading-snug">
          <div className="font-medium">{unattendedFailureTitle(failure.intent)}</div>
          <div className="text-muted-foreground">
            {agentLaunchFailureMessage(failure, 'post-create')}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-6">
        {actionIds.map((id, index) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant={
              isDestructiveRecoveryAction(id) ? 'destructive' : index === 0 ? 'default' : 'outline'
            }
            disabled={busy}
            onClick={() => onAction(id)}
          >
            {recoveryActionLabel(id)}
          </Button>
        ))}
      </div>
    </div>
  )
}
