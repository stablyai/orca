import { ArrowUpRight, Play, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import type { ZotzAgentTaskPriority } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue'
import { formatZotzGb, minutesSince } from './zotz-memory-format'

type Snapshot = ZotzAgentQueueSnapshot
type Running = Snapshot['running'][number]

export type ZotzAgentQueueBoardProps = {
  snapshot: Snapshot
  now: number
  workspaceName: (worktreeId: string | null) => string
  onForceStart: (id: string) => void
  onCancel: (id: string) => void
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

function MemoryBar({ snapshot }: { snapshot: Snapshot }): React.JSX.Element | null {
  const t = useTranslate()
  const memory = snapshot.memory
  if (!memory || memory.totalBytes <= 0) {
    return null
  }
  const agents = snapshot.running.reduce((sum, agent) => sum + agent.bytes, 0)
  const free = Math.min(memory.availableBytes, memory.totalBytes)
  const other = Math.max(0, memory.totalBytes - free - agents)
  const percent = (bytes: number) => `${(bytes / memory.totalBytes) * 100}%`
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-foreground">
          {t('zotz.agentQueue.board.free', '{{free}} GB free of {{total}} GB', {
            free: formatZotzGb(free),
            total: formatZotzGb(memory.totalBytes)
          })}
        </span>
        <span className="text-muted-foreground">
          {t('zotz.agentQueue.board.keepsFree', 'Always keeps {{min}} GB free', {
            min: formatZotzGb(memory.minFreeBytes)
          })}
        </span>
      </div>
      <div className="relative flex h-2.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-muted-foreground/50" style={{ width: percent(other) }} />
        <div className="bg-primary" style={{ width: percent(agents) }} />
        <div
          className="absolute inset-y-0 border-l-2 border-dashed border-destructive"
          style={{ left: `calc(100% - ${percent(memory.minFreeBytes)})` }}
          title={t('zotz.agentQueue.board.minFreeMarker', 'Always free')}
        />
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
    </div>
  )
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
  highlighted,
  children
}: {
  highlighted?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'space-y-1 rounded-md border border-border bg-card p-2 text-card-foreground',
        highlighted && 'border-primary ring-1 ring-primary'
      )}
    >
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

function RunningCard({
  agent,
  props,
  review
}: {
  agent: Running
  props: ZotzAgentQueueBoardProps
  review: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const ceiling = props.snapshot.memory?.perAgentMaxBytes ?? 0
  return (
    <Card>
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

/** The queue board: Backlog → In Progress → Review → Done over a live memory bar (docs/zotz/PLAN.md §8g). */
export function ZotzAgentQueueBoard(props: ZotzAgentQueueBoardProps): React.JSX.Element {
  const t = useTranslate()
  const { snapshot } = props
  const working = snapshot.running.filter((agent) => agent.state === 'working')
  const review = snapshot.running.filter((agent) => agent.state !== 'working')
  const empty = (text: string) => (
    <div className="px-1 py-3 text-center text-[11px] text-muted-foreground">{text}</div>
  )
  return (
    <div className="space-y-3">
      <MemoryBar snapshot={snapshot} />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <Column
          title={t('zotz.agentQueue.board.backlog', 'Backlog')}
          hint={t('zotz.agentQueue.board.backlogHint', 'Turn order: manual › remote › automation')}
          count={snapshot.queued.length}
        >
          {snapshot.queued.length === 0
            ? empty(t('zotz.agentQueue.board.backlogEmpty', 'Nothing waiting'))
            : snapshot.queued.map((task) => (
                <Card key={task.id} highlighted={task.position === 1}>
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
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => props.onCancel(task.id)}
                    >
                      <X className="size-3" />
                      {t('zotz.agentQueue.cancel', 'Cancel')}
                    </Button>
                    <Button type="button" size="xs" onClick={() => props.onForceStart(task.id)}>
                      <Play className="size-3" />
                      {t('zotz.agentQueue.forceStart', 'Launch anyway')}
                    </Button>
                  </div>
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
            : working.map((agent) => (
                <RunningCard key={agent.paneKey} agent={agent} props={props} review={false} />
              ))}
        </Column>
        <Column
          title={t('zotz.agentQueue.board.review', 'Review')}
          hint={t('zotz.agentQueue.board.reviewHint', 'Waiting on you')}
          count={review.length}
        >
          {review.length === 0
            ? empty(t('zotz.agentQueue.board.reviewEmpty', 'Nothing to review'))
            : review.map((agent) => (
                <RunningCard key={agent.paneKey} agent={agent} props={props} review />
              ))}
        </Column>
        <Column
          title={t('zotz.agentQueue.board.done', 'Done')}
          hint={t('zotz.agentQueue.board.doneHint', 'Closed · peaks improve the estimates')}
          count={snapshot.done.length}
        >
          {snapshot.done.length === 0
            ? empty(t('zotz.agentQueue.board.doneEmpty', 'No finished runs yet'))
            : snapshot.done.map((run) => (
                <Card key={`${run.paneKey}-${run.endedAt}`}>
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
