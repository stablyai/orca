import { useEffect, useState } from 'react'
import { Clock, KeyRound, ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { tailscalePingCommand } from '../../../../shared/remote-runtime/remote-runtime-tailscale-hint'
import {
  remoteRuntimeDownForLabel,
  remoteRuntimeTailscaleHintLabel
} from './remote-runtime-recovery-copy'

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) {
      return
    }
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** The one look for "this remote work is recovering", shared by the pane and server notices. */
export function RemoteRuntimeRecoveryCard({
  icon,
  title,
  body,
  downSince = null,
  tailscaleHost = null,
  action = null,
  data
}: {
  icon: 'retrying' | 'waiting' | 'sign-in' | 'stopped'
  title: string
  body: string
  downSince?: number | null
  tailscaleHost?: string | null
  action?: { label: string; onClick: () => void } | null
  data: Record<`data-${string}`, string>
}): React.JSX.Element {
  const now = useNow(downSince !== null)
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center"
      {...data}
    >
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-card/95 px-3 py-3 text-card-foreground shadow-xs backdrop-blur-[1px]"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          {icon === 'retrying' ? (
            <LoadingSpinner className="size-4" />
          ) : icon === 'sign-in' ? (
            <KeyRound className="size-4" />
          ) : icon === 'waiting' ? (
            <Clock className="size-4" />
          ) : (
            <ServerOff className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <div className="min-w-0 truncate text-sm font-semibold">{title}</div>
            {downSince !== null ? (
              // Why hidden: a per-second tick inside the live region would re-announce the whole card.
              <div
                aria-hidden="true"
                className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
              >
                {remoteRuntimeDownForLabel(now - downSince)}
              </div>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{body}</div>
          {tailscaleHost ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0">{remoteRuntimeTailscaleHintLabel()}</span>
              <code className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono select-text">
                {tailscalePingCommand(tailscaleHost)}
              </code>
            </div>
          ) : null}
        </div>
        {action ? (
          <Button size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
