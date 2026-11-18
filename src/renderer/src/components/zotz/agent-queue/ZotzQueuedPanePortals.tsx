import { Hourglass, Play, X } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import type { TerminalPaneController } from '../../terminal-pane/controller/use-terminal-pane-controller'
import { formatZotzGb } from './zotz-memory-format'
import { useZotzAgentQueue } from './zotz-agent-queue-store'

type QueuedTask = ZotzAgentQueueSnapshot['queued'][number]

function waitDetail(task: QueuedTask, snapshot: ZotzAgentQueueSnapshot, t: Translate): string {
  const memory = snapshot.memory
  switch (task.waitReason) {
    case 'concurrency':
      return t(
        'zotz.agentQueue.waitConcurrency',
        '{{running}} of {{max}} agents are already working on this machine.',
        { running: snapshot.running.length, max: memory?.maxConcurrentAgents ?? '—' }
      )
    case 'memory':
      return t(
        'zotz.agentQueue.waitMemory',
        'Needs ~{{need}} GB and {{free}} GB are free; Zotz always keeps {{min}} GB for the system.',
        {
          need: formatZotzGb(task.estimatedBytes),
          free: formatZotzGb(memory?.availableBytes ?? 0),
          min: formatZotzGb(memory?.minFreeBytes ?? 0)
        }
      )
    case 'budget':
      return t(
        'zotz.agentQueue.waitBudget',
        'Agents already use {{used}} of their {{budget}} GB budget.',
        {
          used: formatZotzGb(snapshot.running.reduce((sum, agent) => sum + agent.bytes, 0)),
          budget: formatZotzGb(memory?.agentBudgetBytes ?? 0)
        }
      )
    case 'pressure':
      return t(
        'zotz.agentQueue.waitPressure',
        'The machine is low on memory; nothing new starts until some is freed.'
      )
    case null:
      return t('zotz.agentQueue.waitStarting', 'Checking memory…')
  }
}

/** The card itself, without the pane overlay, so fixtures can render it. */
export function ZotzQueuedPaneCard({
  task,
  snapshot,
  onCancel,
  onForceStart
}: {
  task: QueuedTask
  snapshot: ZotzAgentQueueSnapshot
  onCancel: () => void
  onForceStart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          <Hourglass className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="text-sm font-medium text-foreground">
            {task.position === 1
              ? t('zotz.agentQueue.titleNext', 'Queued · next to start')
              : t('zotz.agentQueue.title', 'Queued · {{ahead}} ahead', {
                  ahead: task.position - 1
                })}
          </div>
          <div className="text-xs text-muted-foreground">{waitDetail(task, snapshot, t)}</div>
          <div className="text-xs text-muted-foreground">
            {t(
              'zotz.agentQueue.autoStart',
              'The agent starts on its own when there is room. Nothing is lost if you wait.'
            )}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          <X className="size-3.5" />
          {t('zotz.agentQueue.cancel', 'Cancel')}
        </Button>
        <Button type="button" size="sm" onClick={onForceStart}>
          <Play className="size-3.5" />
          {t('zotz.agentQueue.forceStart', 'Launch anyway')}
        </Button>
      </div>
    </div>
  )
}

function QueuedPanePortal({
  pane,
  tabId,
  snapshot
}: {
  pane: ManagedPane
  tabId: string
  snapshot: ZotzAgentQueueSnapshot
}): React.JSX.Element | null {
  const task = snapshot.queued.find((entry) => entry.id === makePaneKey(tabId, pane.leafId))
  if (!task) {
    return null
  }
  return createPortal(
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 p-4"
      data-zotz-queued-pane={task.position}
    >
      <ZotzQueuedPaneCard
        task={task}
        snapshot={snapshot}
        onCancel={() => void window.api.zotzAgentQueue.cancel(task.id)}
        onForceStart={() => void window.api.zotzAgentQueue.forceStart(task.id)}
      />
    </div>,
    pane.container,
    `zotz-queued-pane-${pane.id}`
  )
}

/** "Queued" over a pane whose agent waits for memory (docs/zotz/PLAN.md §8g). */
export function ZotzQueuedPanePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element | null {
  const snapshot = useZotzAgentQueue()
  if (snapshot.queued.length === 0) {
    return null
  }
  const { managedPanes, tabId } = controller
  return (
    <>
      {managedPanes.map((pane) => (
        <QueuedPanePortal key={pane.id} pane={pane} tabId={tabId} snapshot={snapshot} />
      ))}
    </>
  )
}
