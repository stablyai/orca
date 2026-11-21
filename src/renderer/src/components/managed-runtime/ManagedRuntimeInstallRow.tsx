import { useState } from 'react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  cancelManagedRuntimeInstall,
  installManagedRuntime,
  removeManagedRuntime
} from '@/runtime/hosts/installation/managed-runtime-install-status'
import type { ManagedRuntimeInstallObservation } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { LoadingSpinner } from '../ui/LoadingSpinner'
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
  buttonSize?: 'xs' | 'default'
  /** False leaves out the ⋯ Reinstall/Remove menu, for rows that only prompt an install. */
  menu?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { observation, agentLabel } = props
  // A click holds its button until the host answers, so a double click starts nothing twice.
  const [pending, setPending] = useState<'install' | 'cancel' | 'remove' | null>(null)
  const view = managedRuntimeInstallView(observation.snapshot, agentLabel, pending === 'cancel', t)
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
              ? t(
                  'components.managed-runtime.cancelFailed',
                  "Couldn't cancel the installation. Try again."
                )
              : t('components.managed-runtime.failed', 'Installation failed. Try again.')
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
  // Status truncates to one line, and each part keeps its dot. A line with an error, a note or a
  // download bar wraps instead: an error is read whole, "Not installed" shouldn't truncate, and the
  // bar moves under the download count with Cancel rather than squeezing it.
  const wraps = Boolean(alert || view.note || view.progress !== null)
  const parts: {
    key: string
    node: React.ReactNode
    fixed: boolean
    dot?: false
    className?: string
  }[] = []
  const trailing = Boolean(alert || action || view.note)
  if (view.status !== null) {
    const status = said(view.status, !trailing)
    parts.push({
      key: 'status',
      fixed: false,
      node: (
        <span className="flex min-w-0 items-center gap-1.5">
          {view.busy ? <LoadingSpinner className="size-3" /> : null}
          <span className={cn('min-w-0', !wraps && 'truncate')} title={status}>
            {status}
          </span>
        </span>
      )
    })
  }
  if (view.progress !== null) {
    parts.push({
      key: 'progress',
      fixed: false,
      dot: false,
      // Starts small so Cancel fits beside it, then grows to its full width where there's room.
      className: 'grow basis-16 max-w-44',
      node: (
        <Progress
          value={view.progress}
          className="h-1 w-full"
          aria-label={t('components.managed-runtime.progress', '{{agent}} download', {
            agent: agentLabel
          })}
        />
      )
    })
  }
  if (alert) {
    parts.push({
      key: 'alert',
      fixed: false,
      node: (
        <span role="alert" className="min-w-0 break-words text-destructive">
          {said(alert, !(action || view.note))}
        </span>
      )
    })
  }
  if (action) {
    parts.push({
      key: 'action',
      fixed: true,
      node: (
        <ManagedRuntimeLinkButton
          disabled={action.kind === 'cancel' ? pending !== null : held}
          onClick={() => act(action.kind, primary(action))}
        >
          {action.label}
        </ManagedRuntimeLinkButton>
      )
    })
  }
  if (view.note) {
    parts.push({ key: 'note', fixed: true, node: view.note })
  }
  const line = (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-4 items-center gap-x-1 text-xs text-muted-foreground tabular-nums',
        wraps && 'flex-wrap',
        view.progress !== null && 'gap-y-1'
      )}
    >
      {parts.map(({ key, node, fixed, dot, className }, index) => (
        <span
          key={key}
          className={cn(
            'flex items-center gap-x-1',
            fixed ? 'shrink-0 whitespace-nowrap' : 'min-w-0',
            className
          )}
        >
          {index === 0 || dot === false ? null : <span>·</span>}
          {node}
        </span>
      ))}
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
              size={props.buttonSize ?? 'xs'}
              disabled={button.kind === 'cancel' ? pending !== null : held}
              onClick={() => act(button.kind, primary(button))}
            >
              {button.label}
            </Button>
          ) : null}
          {props.menu !== false && (install || remove) ? (
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
