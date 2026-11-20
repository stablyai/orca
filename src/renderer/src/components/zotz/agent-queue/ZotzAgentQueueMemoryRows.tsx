import { Badge } from '@/components/ui/badge'
import { HostRowIcon } from '@/components/host-row-icon'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { ZotzAgentQueueMachine } from './ZotzAgentQueueBoard'
import { formatZotzGb } from './zotz-memory-format'

export function MachineName({
  machine,
  className
}: {
  machine: ZotzAgentQueueMachine
  className?: string
}): React.JSX.Element {
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <HostRowIcon hostId={machine.hostId} className="size-3 shrink-0" />
      <span className="truncate">{machine.name}</span>
    </span>
  )
}

function MemoryRow({ machine }: { machine: ZotzAgentQueueMachine }): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = machine
  const memory = snapshot.memory
  const name = (
    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
      <MachineName machine={machine} />
      {machine.isThisDevice ? (
        <Badge variant="hostContext">
          {t('zotz.agentQueue.machines.thisDevice', 'This device')}
        </Badge>
      ) : null}
    </span>
  )
  if (!memory || memory.totalBytes <= 0) {
    return (
      <>
        {name}
        <div className="h-2 rounded-full bg-muted" />
        <span className="text-[11px] text-muted-foreground">
          {t('zotz.agentQueue.waitStarting', 'Checking memory…')}
        </span>
      </>
    )
  }
  const agents = snapshot.running.reduce((sum, agent) => sum + agent.bytes, 0)
  const free = Math.min(memory.availableBytes, memory.totalBytes)
  const other = Math.max(0, memory.totalBytes - free - agents)
  const percent = (bytes: number) => `${(bytes / memory.totalBytes) * 100}%`
  const keepsFree = t('zotz.agentQueue.board.keepsFree', 'Always keeps {{min}} GB free', {
    min: formatZotzGb(memory.minFreeBytes)
  })
  return (
    <>
      {name}
      <div className="relative flex h-2 overflow-hidden rounded-full bg-muted">
        <div className="bg-muted-foreground/50" style={{ width: percent(other) }} />
        <div className="bg-primary" style={{ width: percent(agents) }} />
        <div
          className="absolute inset-y-0 border-l-2 border-dashed border-destructive"
          style={{ left: `calc(100% - ${percent(memory.minFreeBytes)})` }}
          title={keepsFree}
        />
      </div>
      <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
        <span className="font-medium text-foreground">
          {t('zotz.agentQueue.board.free', '{{free}} GB free of {{total}} GB', {
            free: formatZotzGb(free),
            total: formatZotzGb(memory.totalBytes)
          })}
        </span>
        {' · '}
        {keepsFree}
      </span>
    </>
  )
}

/** `queues` holds this machine and the paired Zotz servers, never the SSH host catalog. */
export function MemoryRows({
  queues
}: {
  queues: readonly ZotzAgentQueueMachine[]
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
        {queues.map((machine) => (
          <MemoryRow key={machine.hostId} machine={machine} />
        ))}
      </div>
      <div className="flex gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-muted-foreground/50" />
          {t('zotz.agentQueue.board.legendSystem', 'System and other apps')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary" />
          {t('zotz.agentQueue.board.legendAgents', 'Agents')}
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm border border-dashed border-destructive" />
          {t('zotz.agentQueue.board.legendMinFree', 'Always free')}
        </span>
      </div>
      {queues
        .filter((machine) => !machine.onCancel && machine.snapshot.queued.length > 0)
        .map((machine) => (
          <div key={machine.hostId} className="text-[11px] text-muted-foreground">
            {t(
              'zotz.agentQueue.machines.readOnly',
              'Update Zotz on {{host}} to cancel or launch its waits from here.',
              { host: machine.name }
            )}
          </div>
        ))}
    </div>
  )
}
