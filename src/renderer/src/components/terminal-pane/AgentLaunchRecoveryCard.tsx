import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { agentLaunchFailureMessage } from '@/lib/agent-launch-failure-copy'
import {
  isDestructiveRecoveryAction,
  recoveryActionLabel
} from '@/lib/agent-launch-recovery-action-copy'
import {
  resolveAgentLaunchRecoveryCard,
  type AgentLaunchRecoveryActionId,
  type AgentLaunchRecoveryLiveness
} from '@/lib/agent-launch-recovery-card'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'

function RecoveryActionButton({
  id,
  variant,
  disabled,
  onAction
}: {
  id: AgentLaunchRecoveryActionId
  variant: 'default' | 'outline'
  disabled: boolean
  onAction: (id: AgentLaunchRecoveryActionId) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size="sm"
      variant={isDestructiveRecoveryAction(id) ? 'destructive' : variant}
      disabled={disabled}
      onClick={() => onAction(id)}
    >
      {recoveryActionLabel(id)}
    </Button>
  )
}

/** Presentational durable recovery card for a post-create agent-launch failure.
 *  Store/IPC-free: it resolves the action row from the failure + liveness and
 *  reports the chosen action through `onAction`. Mounted in normal flow above the
 *  terminal (same slot as the notices banner) so the pane ResizeObserver refits. */
export function AgentLaunchRecoveryCard({
  failure,
  liveness,
  busy = false,
  disabledActionIds,
  onAction
}: {
  failure: PersistedAgentLaunchFailure
  liveness: AgentLaunchRecoveryLiveness
  busy?: boolean
  /** Actions the container knows would no-op (e.g. Forget with no pending op). */
  disabledActionIds?: ReadonlySet<AgentLaunchRecoveryActionId>
  onAction: (id: AgentLaunchRecoveryActionId) => void
}): React.JSX.Element {
  const model = resolveAgentLaunchRecoveryCard(failure, { liveness })
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex shrink-0 flex-col gap-2 border-b border-border bg-card px-3 py-2 text-card-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 text-sm leading-snug">
          <div className="font-medium">
            {translate(
              'auto.components.AgentLaunchRecoveryCard.title',
              "This workspace's agent didn't start."
            )}
          </div>
          <div className="text-muted-foreground">
            {agentLaunchFailureMessage(failure, 'post-create')}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-6">
        <RecoveryActionButton
          id={model.primary}
          variant="default"
          disabled={busy || disabledActionIds?.has(model.primary) === true}
          onAction={onAction}
        />
        {model.secondary.map((id) => (
          <RecoveryActionButton
            key={id}
            id={id}
            variant="outline"
            disabled={busy || disabledActionIds?.has(id) === true}
            onAction={onAction}
          />
        ))}
      </div>
    </div>
  )
}
