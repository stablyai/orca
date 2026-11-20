import { ArrowUpRight, Play, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import type { ZotzAgentTaskPriority } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue'
import { formatZotzGb, minutesSince } from './zotz-memory-format'
import { MachineName, MemoryRows } from './ZotzAgentQueueMemoryRows'

type Snapshot = ZotzAgentQueueSnapshot
type Running = Snapshot['running'][number]

/** One machine's queue as the board shows it; each machine has its own RAM and its own line. */
export type ZotzAgentQueueMachine = {
  hostId: ExecutionHostId
  name: string
  /** The machine this window runs on. */
  isThisDevice: boolean
  snapshot: Snapshot
  /** Both absent for a server that does not take these calls; its backlog is then read-only. */
  onForceStart?: (id: string) => void
  onCancel?: (id: string) => void
}

export type ZotzAgentQueueBoardProps = {
  /** This machine first, then each server. */
  machines: readonly ZotzAgentQueueMachine[]
  now: number
  workspaceName: (worktreeId: string | null) => string
  onOpenPane: (paneKey: string, worktreeId: string | null) => void
}

function priorityLabel(priority: ZotzAgentTaskPriority, t: Translate): string {
  switch (priority) {
    case 'manual':
      return t('zotz.agentQueue.board.priorityManual', 'Manual')
    case 'remote':
      return t('zotz.agentQueue.board.priorityRemote', 'Remote')
    case 'automation':
      return t('zotz.agentQueue.board.priorityAutomation', 'Automation')
  }
}

function Column({
  title,
  hint,
  count,
  children
}: {
  title: string
  hint: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/60 p-2">
      <header className="px-1">
        <div className="flex items-baseline gap-1.5 text-xs font-semibold text-foreground">
          {title}
          <span className="font-normal text-muted-foreground">{count}</span>
        </div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </header>
      {children}
    </section>
  )
}

function Card({
  machine,
  showMachine,
  highlighted,
  children
}: {
  machine: ZotzAgentQueueMachine
  /** Off when only one machine is on the board: the mark would say nothing. */
  showMachine: boolean
  highlighted?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'space-y-1 rounded-md border border-border bg-card p-2 text-card-foreground',
        highlighted && 'border-primary ring-1 ring-primary'
      )}
      data-zotz-queue-machine={machine.hostId}
    >
      {showMachine ? (
        <MachineName machine={machine} className="text-[11px] text-muted-foreground" />
      ) : null}
      {children}
    </div>
  )
}

function UsageBar({ bytes, ceiling }: { bytes: number; ceiling: number }): React.JSX.Element {
  const ratio = ceiling > 0 ? Math.min(1, bytes / ceiling) : 0
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full', ratio >= 0.9 ? 'bg-destructive' : 'bg-primary')}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  )
}

function QueuedActions({
  onCancel,
  onForceStart
}: {
  onCancel: () => void
  onForceStart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      <Button type="button" size="xs" variant="outline" onClick={onCancel}>
        <X className="size-3" />
        {t('zotz.agentQueue.cancel', 'Cancel')}
      </Button>
      <Button type="button" size="xs" onClick={onForceStart}>
        <Play className="size-3" />
        {t('zotz.agentQueue.forceStart', 'Launch anyway')}
      </Button>
    </div>
  )
}

function RunningCard({
  agent,
  machine,
  props,
  review
}: {
  agent: Running
  machine: ZotzAgentQueueMachine
  props: ZotzAgentQueueBoardProps
  review: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const ceiling = machine.snapshot.memory?.perAgentMaxBytes ?? 0
  return (
    <Card machine={machine} showMachine={props.machines.length > 1}>
      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-semibold">{agent.agent}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {props.workspaceName(agent.worktreeId)}
        </span>
        <span className="ml-auto shrink-0 font-medium whitespace-nowrap tabular-nums">
          {t('zotz.agentQueue.board.gbAmount', '{{gb}} GB', { gb: formatZotzGb(agent.bytes) })}
        </span>
      </div>
      <UsageBar bytes={agent.bytes} ceiling={ceiling} />
      <div className="text-[11px] text-muted-foreground">
        {review
          ? agent.state === 'done'
            ? t(
                'zotz.agentQueue.board.reviewDone',
                'Finished · the session is still open and holds its memory'
              )
            : t('zotz.agentQueue.board.reviewWaiting', 'Needs your answer')
          : t('zotz.agentQueue.board.runningFor', '{{minutes}} min · peak {{peak}} GB', {
              minutes: minutesSince(agent.startedAt, props.now),
              peak: formatZotzGb(agent.peakBytes)
            })}
      </div>
      {review ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => props.onOpenPane(agent.paneKey, agent.worktreeId)}
          >
            <ArrowUpRight className="size-3" />
            {t('zotz.agentQueue.board.openPane', 'Go to tab')}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}

function withMachine<T>(
  machines: readonly ZotzAgentQueueMachine[],
  pick: (snapshot: Snapshot) => readonly T[]
): { machine: ZotzAgentQueueMachine; item: T }[] {
  return machines.flatMap((machine) => pick(machine.snapshot).map((item) => ({ machine, item })))
}

/** Every machine's queue on one board: a memory line each, then Backlog → In Progress → Review → Done (docs/zotz/PLAN.md §8g). */
export function ZotzAgentQueueBoard(props: ZotzAgentQueueBoardProps): React.JSX.Element {
  const t = useTranslate()
  const { machines } = props
  const showMachine = machines.length > 1
  // Each machine serves its own line, so their next-to-start sit together at the top.
  const queued = withMachine(machines, (s) => s.queued).sort(
    (a, b) => a.item.position - b.item.position
  )
  const running = withMachine(machines, (s) => s.running)
  const working = running.filter(({ item }) => item.state === 'working')
  const review = running.filter(({ item }) => item.state !== 'working')
  const done = withMachine(machines, (s) => s.done).sort((a, b) => b.item.endedAt - a.item.endedAt)
  const empty = (text: string) => (
    <div className="px-1 py-3 text-center text-[11px] text-muted-foreground">{text}</div>
  )
  return (
    <div className="space-y-3">
      <MemoryRows queues={machines} />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <Column
          title={t('zotz.agentQueue.board.backlog', 'Backlog')}
          hint={t('zotz.agentQueue.board.backlogHint', 'Turn order: manual › remote › automation')}
          count={queued.length}
        >
          {queued.length === 0
            ? empty(t('zotz.agentQueue.board.backlogEmpty', 'Nothing waiting'))
            : queued.map(({ machine, item: task }) => (
                <Card
                  key={`${machine.hostId}:${task.id}`}
                  machine={machine}
                  showMachine={showMachine}
                  highlighted={task.position === 1}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold',
                        task.position === 1
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border'
                      )}
                    >
                      {task.position}
                    </span>
                    <span className="min-w-0 truncate font-semibold">{task.agent}</span>
                    <span className="ml-auto shrink-0 font-medium whitespace-nowrap tabular-nums">
                      {t('zotz.agentQueue.board.gbEstimate', '~{{gb}} GB', {
                        gb: formatZotzGb(task.estimatedBytes)
                      })}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="secondary">{priorityLabel(task.priority, t)}</Badge>
                    <span className="min-w-0 truncate">
                      {props.workspaceName(task.label)} ·{' '}
                      {t('zotz.agentQueue.board.waitingFor', '{{minutes}} min waiting', {
                        minutes: minutesSince(task.enqueuedAt, props.now)
                      })}
                    </span>
                  </div>
                  {machine.onCancel && machine.onForceStart ? (
                    <QueuedActions
                      onCancel={() => machine.onCancel?.(task.id)}
                      onForceStart={() => machine.onForceStart?.(task.id)}
                    />
                  ) : null}
                </Card>
              ))}
        </Column>
        <Column
          title={t('zotz.agentQueue.board.inProgress', 'In Progress')}
          hint={t('zotz.agentQueue.board.inProgressHint', 'Working · memory against its cap')}
          count={working.length}
        >
          {working.length === 0
            ? empty(t('zotz.agentQueue.board.inProgressEmpty', 'No agent is working'))
            : working.map(({ machine, item }) => (
                <RunningCard
                  key={`${machine.hostId}:${item.paneKey}`}
                  agent={item}
                  machine={machine}
                  props={props}
                  review={false}
                />
              ))}
        </Column>
        <Column
          title={t('zotz.agentQueue.board.review', 'Review')}
          hint={t('zotz.agentQueue.board.reviewHint', 'Waiting on you')}
          count={review.length}
        >
          {review.length === 0
            ? empty(t('zotz.agentQueue.board.reviewEmpty', 'Nothing to review'))
            : review.map(({ machine, item }) => (
                <RunningCard
                  key={`${machine.hostId}:${item.paneKey}`}
                  agent={item}
                  machine={machine}
                  props={props}
                  review
                />
              ))}
        </Column>
        <Column
          title={t('zotz.agentQueue.board.done', 'Done')}
          hint={t('zotz.agentQueue.board.doneHint', 'Closed · peaks improve the estimates')}
          count={done.length}
        >
          {done.length === 0
            ? empty(t('zotz.agentQueue.board.doneEmpty', 'No finished runs yet'))
            : done.map(({ machine, item: run }) => (
                <Card
                  key={`${machine.hostId}:${run.paneKey}-${run.endedAt}`}
                  machine={machine}
                  showMachine={showMachine}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-semibold">{run.agent}</span>
                    <span className="min-w-0 truncate text-muted-foreground">
                      {props.workspaceName(run.worktreeId)}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {t('zotz.agentQueue.board.doneRun', '{{minutes}} min · peak {{peak}} GB', {
                      minutes: minutesSince(run.startedAt, run.endedAt),
                      peak: formatZotzGb(run.peakBytes)
                    })}
                  </div>
                </Card>
              ))}
        </Column>
      </div>
    </div>
  )
}
