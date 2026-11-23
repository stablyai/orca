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
  // Status truncates to one line. A line with an error, a reason, a note or a download wraps
  // instead: an error, reason or downloaded amount is read whole, "Not installed" shouldn't
  // truncate, and the bar or Cancel moves under the download count rather than squeezing it.
  const wraps = Boolean(alert || view.reason || view.note || view.count || view.progress !== null)
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
    // The row sits under its agent, so short copy leaves the name out; a screen reader still hears it.
    const spoken = view.spokenStatus === null ? null : said(view.spokenStatus, !trailing)
    // A status like "Installed by Orca · 1.5.0" splits into parts, so it wraps at its dot like the rest.
    const [first, ...rest] = spoken === null ? status.split(' · ') : [status]
    const truncate = cn('min-w-0', !wraps && 'truncate')
    parts.push({
      key: 'status',
      fixed: false,
      node: (
        <span className="flex min-w-0 items-center gap-1.5">
          {view.busy ? <LoadingSpinner className="size-3" /> : null}
          <span className={truncate} title={spoken ?? status}>
            {spoken === null ? (
              first
            ) : (
              <>
                <span aria-hidden="true">{status}</span>
                <span className="sr-only">{spoken}</span>
              </>
            )}
          </span>
        </span>
      )
    })
    rest.forEach((segment, index) =>
      parts.push({
        key: `status-${index}`,
        fixed: false,
        node: <span className={truncate}>{segment}</span>
      })
    )
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
      // An error takes its own line, so the action after it starts the next one.
      className: 'basis-full',
      node: (
        // Read whole with its full stop, since nothing follows it on its line.
        <span role="alert" className="min-w-0 break-words text-destructive">
          {alert}
        </span>
      )
    })
  }
  if (action) {
    parts.push({
      key: 'action',
      fixed: true,
      // After the bar, Cancel needs no dot.
      ...(view.progress !== null ? { dot: false as const } : {}),
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
  // Each part draws its "·" in a left gutter. The parts sit one gutter to the left of the clipped
  // line, so whichever part starts a line loses its dot: no line starts or ends with one. The dot's
  // empty alt text (`'·' / ''`) keeps it out of the accessibility tree, clipped or not.
  const line = (
    <div
      role="status"
      aria-live="polite"
      className="min-h-4 overflow-x-clip text-xs text-muted-foreground tabular-nums [overflow-clip-margin:3px]"
    >
      <div
        className={cn(
          '-ml-3 flex items-center',
          wraps && 'flex-wrap',
          view.progress !== null && 'gap-y-1'
        )}
      >
        {parts.map(({ key, node, fixed, dot, className }) => (
          <span
            key={key}
            className={cn(
              'relative flex items-center pl-3',
              dot !== false &&
                "before:absolute before:inset-y-0 before:left-0 before:w-3 before:text-center before:content-['·'_/_'']",
              fixed ? 'shrink-0 whitespace-nowrap' : 'min-w-0',
              className
            )}
          >
            {node}
          </span>
        ))}
      </div>
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
