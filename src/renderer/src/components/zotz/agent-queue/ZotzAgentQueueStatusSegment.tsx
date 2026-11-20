import { ListOrdered } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useTranslate } from '@/i18n/use-translate'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from '../../status-bar/composition/status-bar-context-menu-policy'
import { cn } from '@/lib/class-names'
import { formatZotzGb } from './zotz-memory-format'
import { useZotzAgentQueue } from './zotz-agent-queue-store'
import { useZotzHostAgentQueues } from './zotz-host-agent-queue-store'
import {
  setZotzAgentQueueDrawerOpen,
  useZotzAgentQueueDrawerOpen
} from './zotz-agent-queue-drawer-open'

/** Status bar entry for the agent queue: free memory, how many wait on any machine, and the board on click. */
export function ZotzAgentQueueStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const snapshot = useZotzAgentQueue()
  const hostQueues = useZotzHostAgentQueues()
  const open = useZotzAgentQueueDrawerOpen()

  if (isPairedWebClientWindow()) {
    return null
  }

  const memory = snapshot.memory
  // Free memory is this machine's; the count covers every machine, so a server's wait shows here too.
  const queued = [...hostQueues.values()].reduce(
    (sum, queue) => sum + queue.queued.length,
    snapshot.queued.length
  )
  const label = memory
    ? queued > 0
      ? t('zotz.agentQueue.segment.withQueue', '{{free}} GB free · {{queued}} queued', {
          free: formatZotzGb(memory.availableBytes),
          queued
        })
      : t('zotz.agentQueue.segment.free', '{{free}} GB free', {
          free: formatZotzGb(memory.availableBytes)
        })
    : t('zotz.agentQueue.segment.idle', 'Agent queue')
  const dot =
    memory?.pressure === 'critical'
      ? 'bg-destructive'
      : memory?.pressure === 'elevated' || queued > 0
        ? 'bg-agent-question'
        : 'bg-muted-foreground/40'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
          className="inline-flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setZotzAgentQueueDrawerOpen(!open)}
        >
          <ListOrdered className="size-3" />
          {!iconOnly ? <span className="text-[11px] font-medium">{label}</span> : null}
          <span aria-hidden className={cn('size-1.5 rounded-full', dot)} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {t('zotz.agentQueue.segment.tooltip', 'Agent queue and memory')}
      </TooltipContent>
    </Tooltip>
  )
}
