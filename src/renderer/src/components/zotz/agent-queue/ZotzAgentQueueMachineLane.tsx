import { useState } from 'react'
import { ChevronRight, Hourglass } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { HostRowIcon } from '@/components/host-row-icon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { ZotzAgentQueueBoard, type ZotzAgentQueueBoardProps } from './ZotzAgentQueueBoard'
import { formatZotzGb } from './zotz-memory-format'

export type ZotzAgentQueueMachine = Omit<ZotzAgentQueueBoardProps, 'now' | 'onOpenPane'> & {
  hostId: ExecutionHostId
  name: string
  /** The machine this window runs on. */
  isThisDevice: boolean
}

function MachineSummary({
  machine,
  showMemory
}: {
  machine: ZotzAgentQueueMachine
  /** Off while the board is open: its memory bar already says it. */
  showMemory: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = machine
  const queued = snapshot.queued.length
  const working = snapshot.running.filter((agent) => agent.state === 'working').length
  const review = snapshot.running.length - working
  const memory = snapshot.memory
  return (
    <span className="ml-auto flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground tabular-nums">
      {queued > 0 ? (
        <span className="flex items-center gap-1 font-medium text-agent-question-text">
          <Hourglass className="size-3" />
          {t('zotz.agentQueue.machines.queued', '{{count}} queued', { count: queued })}
        </span>
      ) : null}
      <span>{t('zotz.agentQueue.machines.working', '{{count}} working', { count: working })}</span>
      {review > 0 ? (
        <span>
          {t('zotz.agentQueue.machines.review', '{{count}} to review', { count: review })}
        </span>
      ) : null}
      {memory && showMemory ? (
        <span className="font-medium text-foreground">
          {t('zotz.agentQueue.board.free', '{{free}} GB free of {{total}} GB', {
            free: formatZotzGb(memory.availableBytes),
            total: formatZotzGb(memory.totalBytes)
          })}
        </span>
      ) : null}
    </span>
  )
}

/** One machine's memory and queue: each has its own RAM, so its board never mixes with another's. */
export function ZotzAgentQueueMachineLane({
  machine,
  now,
  onOpenPane
}: {
  machine: ZotzAgentQueueMachine
  now: number
  onOpenPane: ZotzAgentQueueBoardProps['onOpenPane']
}): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = machine
  const [open, setOpen] = useState(
    machine.isThisDevice || snapshot.queued.length > 0 || snapshot.running.length > 0
  )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border"
      data-zotz-queue-machine={machine.hostId}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <HostRowIcon hostId={machine.hostId} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {machine.name}
        </span>
        {machine.isThisDevice ? (
          <Badge variant="hostContext">
            {t('zotz.agentQueue.machines.thisDevice', 'This device')}
          </Badge>
        ) : null}
        <MachineSummary machine={machine} showMemory={!open} />
      </CollapsibleTrigger>
      <CollapsibleContent animation="height">
        <div className="space-y-2 border-t border-border p-3">
          {!machine.onCancel && snapshot.queued.length > 0 ? (
            <div className="text-[11px] text-muted-foreground">
              {t(
                'zotz.agentQueue.machines.readOnly',
                'Update Zotz on {{host}} to cancel or launch its waits from here.',
                { host: machine.name }
              )}
            </div>
          ) : null}
          <ZotzAgentQueueBoard {...machine} now={now} onOpenPane={onOpenPane} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
