import { useEffect } from 'react'
import { CloudOff, History } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { requestCrossMachineRecoveryDialog } from './cross-machine-recovery-dialog-request'
import {
  refreshCrossMachineRecovery,
  useCrossMachineRecoverySnapshot
} from './cross-machine-recovery-provider-store'
import { pauseReasonLabel } from './cross-machine-recovery-copy'

// Why: each read execs the provider CLI, so the bar polls slowly; opening the dialog reads fresh.
const REFRESH_INTERVAL_MS = 5 * 60_000

export function CrossMachineRecoveryStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const supported = window.api.crossMachineRecovery.isSupported
  const { status, list } = useCrossMachineRecoverySnapshot()
  useEffect(() => {
    if (!supported) {
      return
    }
    void refreshCrossMachineRecovery()
    const timer = setInterval(() => void refreshCrossMachineRecovery(), REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [supported])

  if (!supported || !status?.ok) {
    return null
  }
  const count = list?.ok ? list.value.items.length : 0
  const pause = status.value.peers.find((peer) => peer.pause)?.pause ?? null
  const stopped = !status.value.helper.running
  if (count === 0 && !pause && !stopped) {
    return null
  }
  const countLabel =
    count === 1
      ? translate('components.cross-machine-recovery.status.countOne', '1 recoverable workspace')
      : translate(
          'components.cross-machine-recovery.status.count',
          '{{count}} recoverable workspaces',
          { count }
        )
  const health = stopped
    ? translate('components.cross-machine-recovery.status.stopped', 'Sync helper is not running')
    : pause
      ? pauseReasonLabel(pause)
      : null
  const label = health ?? countLabel
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={requestCrossMachineRecoveryDialog}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={health ? `${health}. ${countLabel}` : countLabel}
          data-testid="cross-machine-recovery-status"
        >
          {health ? (
            <CloudOff className="size-3 text-muted-foreground" />
          ) : (
            <History className="size-3 text-muted-foreground" />
          )}
          <span className="text-[11px]">{iconOnly ? count : label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {translate(
          'components.cross-machine-recovery.status.tooltip',
          'Recover work from your other computers. Click to choose.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
