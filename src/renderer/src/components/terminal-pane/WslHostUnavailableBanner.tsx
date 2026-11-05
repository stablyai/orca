import { ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openWslHostsExperimentalSetting } from '../sidebar/use-wsl-hosts-enabled'
import {
  getWslHostServerFilesMissingLabel,
  getWslHostsTurnedOffLabel,
  getWslHostsTurnOnLabel
} from '../sidebar/wsl-host-row-status'
import type { WslHostUnavailableReason } from './use-wsl-host-unavailable-reason'

/** In place of "Reconnecting…" for a WSL host that cannot run: nothing retries, so say why. */
export function WslHostUnavailableBanner({
  reason
}: {
  reason: WslHostUnavailableReason
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center"
      data-terminal-wsl-host-unavailable-banner={reason}
    >
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-card/95 px-3 py-3 text-card-foreground shadow-xs backdrop-blur-[1px]"
        role="status"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          <ServerOff className="size-4" />
        </div>
        <div className="min-w-0 flex-1 text-sm font-semibold">
          {reason === 'turned-off'
            ? getWslHostsTurnedOffLabel()
            : getWslHostServerFilesMissingLabel()}
        </div>
        {reason === 'turned-off' ? (
          <Button size="sm" onClick={openWslHostsExperimentalSetting}>
            {getWslHostsTurnOnLabel()}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
