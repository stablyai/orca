import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  cancelManagedRuntimeInstall,
  installManagedRuntime
} from '@/runtime/managed-runtime-install-status'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import {
  managedRuntimeInstallView,
  type ManagedRuntimeInstallAction
} from './managed-runtime-install-view'

/** Settings' Install, progress and Cancel for the runtime Orca provides an agent, on the host it
 *  runs on. A chat's install card shows the same host answer, so either one's action moves both. */
export function ManagedRuntimeInstallRow(props: {
  observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
  agentLabel: string
}): React.JSX.Element {
  const { observation, agentLabel } = props
  // A click holds its button until the host answers, so a double click starts nothing twice.
  const [pending, setPending] = useState<ManagedRuntimeInstallAction['kind'] | null>(null)
  const view = managedRuntimeInstallView(observation.snapshot, agentLabel, pending === 'cancel')
  const [refusal, setRefusal] = useState<string | null>(null)
  const act = (action: ManagedRuntimeInstallAction): void => {
    setPending(action.kind)
    setRefusal(null)
    const { subject } = observation
    const request =
      action.kind === 'cancel'
        ? cancelManagedRuntimeInstall(subject, action.operationId)
        : installManagedRuntime(subject)
    void request
      .catch((cause: unknown) =>
        setRefusal(
          cause instanceof Error
            ? cause.message
            : action.kind === 'cancel'
              ? translate(
                  'components.managed-runtime.cancelFailed',
                  "Couldn't cancel the installation. Try again."
                )
              : translate('components.managed-runtime.failed', 'Installation failed. Try again.')
        )
      )
      .finally(() => setPending(null))
  }
  const alert = refusal ?? view.error
  const { action } = view
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-xs">
      <div className="min-w-0 flex-1 space-y-1">
        {/* The line stays while the first read is out, so nothing shifts when it lands. */}
        <p role="status" aria-live="polite" className="min-h-4 text-muted-foreground tabular-nums">
          {view.status}
        </p>
        {view.progress === null ? null : (
          <Progress
            value={view.progress}
            aria-label={translate('components.managed-runtime.progress', '{{agent}} download', {
              agent: agentLabel
            })}
          />
        )}
        {alert ? (
          <p role="alert" className="break-words text-destructive">
            {alert}
          </p>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 justify-end">
          <Button
            size="xs"
            variant={action.kind === 'cancel' ? 'ghost' : 'outline'}
            disabled={pending !== null}
            onClick={() => act(action)}
          >
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
