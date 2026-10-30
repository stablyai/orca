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
import { ManagedRuntimeActionsMenu } from './ManagedRuntimeActionsMenu'
import { ManagedRuntimeLinkButton } from './ManagedRuntimeLinkButton'

// Parts are joined by ' · ', so a sentence followed by another part drops its full stop.
const said = (text: string, last: boolean): string => (last ? text : text.replace(/[.。]$/u, ''))

/** Use the host’s shared install snapshot so Settings and chat agree; the caller owns first-install and menu actions. */
export function ManagedRuntimeInstallRow(props: {
  observation: Extract<ManagedRuntimeInstallObservation, { kind: 'active' }>
  agentLabel: string
  children: (line: React.ReactNode, actions: React.ReactNode) => React.ReactNode
  /** A sign-in runs the installed server, so Install and Remove wait for it; Cancel does not. */
  signInRunning?: boolean
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
  const held = pending !== null || props.signInRunning === true
  const primary = (chosen: ManagedRuntimeInstallAction) => () =>
    chosen.kind === 'cancel'
      ? cancelManagedRuntimeInstall(subject, chosen.operationId)
      : installManagedRuntime(subject)
  const parts: React.ReactNode[] = []
  const trailing = Boolean(alert || action || view.note)
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
        {said(alert, !(action || view.note))}
      </span>
    )
  }
  if (action) {
    parts.push(
      <ManagedRuntimeLinkButton
        key="action"
        disabled={action.kind === 'cancel' ? pending !== null : held}
        onClick={() => act(action.kind, primary(action))}
      >
        {action.label}
      </ManagedRuntimeLinkButton>
    )
  }
  if (view.note) {
    parts.push(<span key="note">{view.note}</span>)
  }
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
  const menu = view.menuAction
  const install = menu && { label: menu.label, onSelect: () => act(menu.kind, primary(menu)) }
  const remove = removable ? () => act('remove', () => removeManagedRuntime(subject)) : null
  return (
    <>
      {props.children(
        line,
        <>
          {button ? (
            <Button
              size="xs"
              disabled={button.kind === 'cancel' ? pending !== null : held}
              onClick={() => act(button.kind, primary(button))}
            >
              {button.label}
            </Button>
          ) : null}
          {install || remove ? (
            <ManagedRuntimeActionsMenu
              agentLabel={agentLabel}
              host={subject.target}
              install={install}
              onRemove={remove}
              disabled={held}
            />
          ) : null}
        </>
      )}
    </>
  )
}
