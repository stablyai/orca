import React from 'react'
import { ArrowRight, LoaderCircle, Plug, RotateCw, TriangleAlert, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimePortForward } from '../../../../shared/runtime-port-forwards'

export type RuntimePortForwardRowState =
  | { kind: 'forwarded'; forward: RuntimePortForward }
  | { kind: 'pending' }
  | { kind: 'unforwarded' }
  | { kind: 'failed'; message: string; busy: boolean }

const CHIP =
  'inline-flex shrink-0 items-center gap-1 rounded-sm px-1 -mx-1 text-2xs leading-4 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring motion-safe:transition-colors'

/** The line under a remote port: where it lands on this computer, or a control to forward it. */
export function RuntimePortForwardStatus({
  remotePort,
  state,
  onForward,
  onOpenLocal
}: {
  remotePort: number
  state: RuntimePortForwardRowState
  onForward: () => void
  onOpenLocal: (forward: RuntimePortForward) => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state.kind === 'forwarded') {
    const { forward } = state
    const unreachable = Boolean(forward.lastError)
    const remapped = forward.localPort !== remotePort
    const note = unreachable
      ? t('auto.components.right.sidebar.RuntimePortForward.noResponse', 'no response on host')
      : remapped
        ? t('auto.components.right.sidebar.RuntimePortForward.remapped', '({{value0}} taken)', {
            value0: remotePort
          })
        : null
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <button
          type="button"
          className={cn(
            CHIP,
            'max-w-full text-foreground/85 hover:bg-accent hover:text-foreground'
          )}
          onClick={() => onOpenLocal(forward)}
          aria-label={
            unreachable
              ? t(
                  'auto.components.right.sidebar.RuntimePortForward.unreachableLabel',
                  'Port {{value0}} is forwarded to localhost:{{value1}}, but nothing answers on the host. Open in browser',
                  { value0: remotePort, value1: forward.localPort }
                )
              : t(
                  'auto.components.right.sidebar.RuntimePortForward.forwardedLabel',
                  'Port {{value0}} is forwarded to localhost:{{value1}}. Open in browser',
                  { value0: remotePort, value1: forward.localPort }
                )
          }
        >
          {unreachable ? (
            <TriangleAlert size={11} aria-hidden className="shrink-0 text-status-warning-text" />
          ) : (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-status-success" />
          )}
          <ArrowRight size={11} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">
            {t(
              'auto.components.right.sidebar.RuntimePortForward.localAddress',
              'localhost:{{value0}}',
              {
                value0: forward.localPort
              }
            )}
          </span>
        </button>
        {note ? (
          <span
            className={cn(
              'shrink-0 text-2xs',
              unreachable ? 'text-status-warning-text' : 'text-muted-foreground'
            )}
          >
            {note}
          </span>
        ) : null}
      </span>
    )
  }
  if (state.kind === 'pending') {
    return (
      <span className={cn(CHIP, 'text-muted-foreground')} role="status">
        <LoaderCircle size={11} aria-hidden className="shrink-0 motion-safe:animate-spin" />
        {t('auto.components.right.sidebar.RuntimePortForward.pending', 'Forwarding…')}
      </span>
    )
  }
  const action =
    state.kind === 'failed'
      ? state.busy
        ? {
            icon: <Plug size={11} aria-hidden className="shrink-0" />,
            label: t(
              'auto.components.right.sidebar.RuntimePortForward.useAnother',
              'Use another port'
            )
          }
        : {
            icon: <RotateCw size={11} aria-hidden className="shrink-0" />,
            label: t('auto.components.right.sidebar.RuntimePortForward.retry', 'Retry')
          }
      : {
          icon: <Plug size={11} aria-hidden className="shrink-0" />,
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
      <button
        type="button"
        className={cn(CHIP, 'text-muted-foreground hover:bg-accent hover:text-foreground')}
        onClick={onForward}
        aria-label={`${action.label} (:${remotePort})`}
      >
        {action.icon}
        {action.label}
      </button>
    </span>
  )
}

/** Stop Forwarding as a row hover action, beside Open and Copy. */
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
        {t('auto.components.right.sidebar.RuntimePortForward.stop', 'Stop Forwarding')}
      </TooltipContent>
    </Tooltip>
  )
}
