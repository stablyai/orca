import React from 'react'
import { ArrowRight, LoaderCircle, Plug, RotateCw, TriangleAlert, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimePortForward } from '../../../../shared/runtime-port-forwards'

export type RuntimePortForwardRowState =
  | { kind: 'forwarded'; forward: RuntimePortForward; hostOffline?: boolean }
  | { kind: 'pending' }
  | { kind: 'unforwarded' }
  | { kind: 'failed'; message: string; busy: boolean }

const FOCUS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring'
const ACTION =
  'h-5 px-1 text-2xs font-normal text-muted-foreground hover:text-foreground [&_svg]:size-3'

/** The line under a remote port: where it lands on this computer, or a control to forward it. */
export function RuntimePortForwardStatus({
  remotePort,
  state,
  onForward,
  onOpenLocal,
  onReconnect
}: {
  remotePort: number
  state: RuntimePortForwardRowState
  onForward: () => void
  onOpenLocal: (forward: RuntimePortForward) => void
  onReconnect?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state.kind === 'forwarded') {
    const { forward } = state
    const offline = state.hostOffline === true
    const unreachable = !offline && Boolean(forward.lastError)
    const remapped = forward.localPort !== remotePort
    const note = offline
      ? t('auto.components.right.sidebar.RuntimePortForward.hostOfflineNote', 'Host offline')
      : unreachable
        ? t(
            'auto.components.right.sidebar.RuntimePortForward.notAnswering',
            'Nothing answering on :{{value0}} yet',
            { value0: remotePort }
          )
        : remapped
          ? t(
              'auto.components.right.sidebar.RuntimePortForward.remappedInUseHere',
              '({{value0}} in use here)',
              { value0: remotePort }
            )
          : null
    const localAddress = t(
      'auto.components.right.sidebar.RuntimePortForward.localAddress',
      'localhost:{{value0}}',
      { value0: forward.localPort }
    )
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <button
          type="button"
          className={cn(
            'inline-flex max-w-full shrink-0 items-center gap-1 rounded-sm px-1 -mx-1 text-2xs leading-4 text-foreground/85 hover:bg-accent hover:text-foreground motion-safe:transition-colors',
            FOCUS
          )}
          onClick={() => onOpenLocal(forward)}
          aria-label={[
            t(
              'auto.components.right.sidebar.RuntimePortForward.forwardedToLabel',
              'Port {{value0}} is forwarded to {{value1}}. Open in browser',
              { value0: remotePort, value1: localAddress }
            ),
            note
          ]
            .filter(Boolean)
            .join('. ')}
        >
          {unreachable ? (
            <TriangleAlert size={11} aria-hidden className="shrink-0 text-status-warning-text" />
          ) : (
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                offline ? 'bg-muted-foreground/50' : 'bg-status-success'
              )}
            />
          )}
          <ArrowRight size={11} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{localAddress}</span>
        </button>
        {note ? (
          <span
            className={cn(
              'shrink-0 whitespace-nowrap text-2xs',
              unreachable ? 'text-status-warning-text' : 'text-muted-foreground'
            )}
          >
            {note}
          </span>
        ) : null}
        {offline && onReconnect ? (
          <Button type="button" variant="ghost" size="xs" className={ACTION} onClick={onReconnect}>
            {t('auto.components.right.sidebar.RuntimePortForward.reconnect', 'Reconnect')}
          </Button>
        ) : null}
      </span>
    )
  }
  if (state.kind === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs leading-5 text-muted-foreground">
        <LoaderCircle size={11} aria-hidden className="shrink-0 motion-safe:animate-spin" />
        {t('auto.components.right.sidebar.RuntimePortForward.pending', 'Forwarding…')}
      </span>
    )
  }
  const action =
    state.kind === 'failed'
      ? state.busy
        ? {
            icon: <Plug aria-hidden />,
            label: t(
              'auto.components.right.sidebar.RuntimePortForward.useAnother',
              'Use another port'
            )
          }
        : {
            icon: <RotateCw aria-hidden />,
            label: t('auto.components.right.sidebar.RuntimePortForward.retry', 'Retry')
          }
      : {
          icon: <Plug aria-hidden />,
          label: t(
            'auto.components.right.sidebar.RuntimePortForward.forward',
            'Forward to localhost'
          )
        }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      {state.kind === 'failed' ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-status-warning-text">
          <TriangleAlert size={11} aria-hidden className="shrink-0" />
          <span>{state.message}</span>
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={cn(ACTION, '-mx-1')}
        onClick={onForward}
        aria-label={t(
          'auto.components.right.sidebar.RuntimePortForward.actionLabel',
          '{{value0}} for port {{value1}}',
          { value0: action.label, value1: remotePort }
        )}
      >
        {action.icon}
        {action.label}
      </Button>
    </span>
  )
}

/** Stop forwarding as a row hover action, beside Open and Copy. */
export function RuntimePortForwardStopButton({
  remotePort,
  onStop
}: {
  remotePort: number
  onStop: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t(
    'auto.components.right.sidebar.RuntimeForwardedPorts.stopLabel',
    'Stop forwarding port {{value0}}',
    { value0: remotePort }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          onClick={onStop}
          aria-label={label}
        >
          <Unplug size={13} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t('auto.components.right.sidebar.RuntimePortForward.stopForwarding', 'Stop forwarding')}
      </TooltipContent>
    </Tooltip>
  )
}
