import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { agentLaunchFailureMessage } from '@/lib/agent-launch-failure-copy'
import { recoveryActionLabel } from '@/lib/agent-launch-recovery-action-copy'
import type { PersistedAgentLaunchFailure } from '../../../../shared/agent-launch-contract'

/** Display + Forget recovery card for an automation run whose agent launch failed
 *  or was left stranded. Renders the client-safe code+hint only (never argv/env/
 *  paths). Forget is offered only while the launch is provider-unknown (plan :941)
 *  and a forgotten automation run never retries (plan :498), so — unlike the
 *  workspace card — this one never offers Retry. */
export function AutomationRunLaunchFailure({
  failure,
  forgottenAt,
  onForget,
  busy = false
}: {
  failure: PersistedAgentLaunchFailure
  forgottenAt: number | null
  onForget?: () => void
  busy?: boolean
}): React.JSX.Element {
  // Forget frees the stranded reservation but cannot stop a possibly-live remote
  // process, so it is offered only for the provider-unknown state (plan :941).
  const canForget = !forgottenAt && failure.code === 'launch_state_unknown' && Boolean(onForget)
  return (
    <div
      role="alert"
      aria-live="polite"
      className="mb-4 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-card-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm leading-snug">
        <div className="font-medium">
          {translate(
            'agentLaunch.unattendedFailure.title.automation',
            "An automation's agent didn't start."
          )}
        </div>
        <div className="mt-0.5 text-muted-foreground">
          {agentLaunchFailureMessage(failure, 'post-create')}
        </div>
        {forgottenAt ? (
          <div className="mt-1 text-muted-foreground">
            {translate(
              'agentLaunch.unattendedFailure.forgotten',
              "You forgot this launch, so it won't run again."
            )}
          </div>
        ) : null}
        {canForget ? (
          <div className="mt-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={onForget}
            >
              {recoveryActionLabel('forget-launch')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
