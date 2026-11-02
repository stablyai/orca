import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  cancelManagedRuntimeInstall,
  installManagedRuntime,
  removeManagedRuntime
} from '@/runtime/managed-runtime-install-status'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { Progress } from '../ui/progress'
import {
  managedRuntimeInstallView,
  type ManagedRuntimeInstallAction
} from './managed-runtime-install-view'
import { ManagedRuntimeLinkButton } from './ManagedRuntimeLinkButton'
import { ManagedRuntimeRemoveButton } from './ManagedRuntimeRemoveButton'

// Parts are joined by ' · ', so a sentence followed by another part drops its full stop.
const said = (text: string, last: boolean): string => (last ? text : text.replace(/[.。]$/u, ''))

/** Settings' one-line install state for the runtime Orca provides an agent, on the host it runs on,
 *  with its actions as links, except a first Install, which is a button the caller places at its
 *  row's end. A chat's install card shows the same host answer, so either one's action moves both. */
export function ManagedRuntimeInstallRow(props: {
  observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
  agentLabel: string
  children: (line: React.ReactNode, button: React.ReactNode) => React.ReactNode
}): React.JSX.Element {
  const { observation, agentLabel } = props
  // A click holds its button until the host answers, so a double click starts nothing twice.
  const [pending, setPending] = useState<'install' | 'cancel' | 'remove' | null>(null)
  const view = managedRuntimeInstallView(observation.snapshot, agentLabel, pending === 'cancel')
  const [refusal, setRefusal] = useState<string | null>(null)
  const { subject } = observation
  const act = (kind: 'install' | 'cancel' | 'remove', request: () => Promise<void>): void => {
    setPending(kind)
    setRefusal(null)
    void request()
      .catch((cause: unknown) =>
        setRefusal(
          cause instanceof Error
            ? cause.message
            : kind === 'cancel'
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
  const button = view.prominent ? view.action : null
  const action = button ? null : view.action
  const removable = observation.removable && view.removable
  const primary = (chosen: ManagedRuntimeInstallAction) => () =>
    chosen.kind === 'cancel'
      ? cancelManagedRuntimeInstall(subject, chosen.operationId)
      : installManagedRuntime(subject)
  const parts: React.ReactNode[] = []
  const trailing = Boolean(alert || action || removable || view.note)
  if (view.status !== null) {
    parts.push(
      <span key="status" className="inline-flex items-center gap-1.5">
        {view.removing ? <LoadingSpinner className="size-3" /> : null}
        {said(view.status, !trailing)}
        {view.progress === null ? null : (
          <Progress
            value={view.progress}
            className="h-1 w-44"
            aria-label={translate('components.managed-runtime.progress', '{{agent}} download', {
              agent: agentLabel
            })}
          />
        )}
      </span>
    )
  }
  if (alert) {
    parts.push(
      <span key="alert" role="alert" className="break-words text-destructive">
        {said(alert, !(action || removable || view.note))}
      </span>
    )
  }
  if (action) {
    parts.push(
      <ManagedRuntimeLinkButton
        key="action"
        disabled={pending !== null}
        onClick={() => act(action.kind, primary(action))}
      >
        {action.label}
      </ManagedRuntimeLinkButton>
    )
  }
  if (removable) {
    parts.push(
      <ManagedRuntimeRemoveButton
        key="remove"
        agentLabel={agentLabel}
        host={subject.target}
        disabled={pending !== null}
        onRemove={() => act('remove', () => removeManagedRuntime(subject))}
      />
    )
  }
  if (view.note) {
    parts.push(<span key="note">{view.note}</span>)
  }
  // The line keeps its height while the first read is out, so nothing shifts when it lands.
  const line = (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-4 flex-wrap items-center gap-x-1 text-xs text-muted-foreground tabular-nums"
    >
      {parts.flatMap((part, index) =>
        index === 0 ? [part] : [<span key={`sep-${index}`}>·</span>, part]
      )}
    </div>
  )
  return (
    <>
      {props.children(
        line,
        button ? (
          <Button
            size="xs"
            disabled={pending !== null}
            onClick={() => act(button.kind, primary(button))}
          >
            {button.label}
          </Button>
        ) : null
      )}
    </>
  )
}
