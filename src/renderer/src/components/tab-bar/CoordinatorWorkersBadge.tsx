import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Square, X } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import { activateWorktreeAgentPane } from '@/components/sidebar/workspace-card/activity/use-worktree-agent-activation'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import {
  selectCoordinatorNeedsYouCount,
  selectCoordinatorWorkers,
  type CoordinatorWorkerEntry,
  type WorkerListState
} from './worker-tab-presentation'
import { workerTabPaneKey, workerTabStopRequiresHome } from './worker-tab-run-state'
import {
  explainWorkerTabHomeStop,
  requestWorkerTabClose,
  requestWorkerTabConfirm
} from './worker-tab-confirm-request'

let openCoordinatorTabId: string | null = null
const openListeners = new Set<() => void>()

/** "Workers…" in the coordinator tab's menu opens the same list as its badge. */
export function openCoordinatorWorkers(coordinatorTabId: string | null): void {
  openCoordinatorTabId = coordinatorTabId
  for (const listener of openListeners) {
    listener()
  }
}

function subscribeOpen(listener: () => void): () => void {
  openListeners.add(listener)
  return () => openListeners.delete(listener)
}

export function stateLabel(state: WorkerListState, t: Translate): string {
  switch (state) {
    case 'needs-you':
      return t('workerTabs.state.needsYou', 'Needs you')
    case 'failed':
      return t('workerTabs.state.failed', 'Failed')
    case 'running':
      return t('workerTabs.state.running', 'Running')
    case 'done':
      return t('workerTabs.state.done', 'Done')
    case 'stopped':
      return t('workerTabs.state.stopped', 'Stopped')
  }
}

function openWorker(entry: CoordinatorWorkerEntry): void {
  const paneKey = workerTabPaneKey(entry.tab)
  if (entry.tab.contentType === 'terminal' && paneKey && parsePaneKey(paneKey)) {
    activateWorktreeAgentPane(entry.worktreeId, entry.tab.entityId, paneKey)
    return
  }
  useAppStore.getState().activateTab(entry.tab.id, { worktreeId: entry.worktreeId })
}

function WorkerRow({ entry, onDone }: { entry: CoordinatorWorkerEntry; onDone: () => void }) {
  const t = useTranslate()
  const finished = entry.state === 'done' || entry.state === 'failed' || entry.state === 'stopped'
  const requiresHome = workerTabStopRequiresHome(entry.tab)
  const homeReason = t('workerTabs.remote.stopReason', 'Stop it on the computer that started it')
  const actionLabel = finished
    ? t('workerTabs.list.close', 'Close {{title}}', { title: entry.title })
    : t('workerTabs.list.stop', 'Stop {{title}}', { title: entry.title })
  const via = entry.viaTitle
    ? t('workerTabs.list.via', 'via {{title}}', { title: entry.viaTitle })
    : entry.viaClosedWorker
      ? t('workerTabs.list.viaClosed', 'via a closed worker')
      : null
  return (
    <div className="flex items-center gap-1 rounded-sm px-1 hover:bg-accent">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col items-start px-1 py-1 text-left text-xs"
        onClick={() => {
          onDone()
          openWorker(entry)
        }}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {entry.state === 'needs-you' ? (
            <span
              aria-hidden
              className="size-2 shrink-0 rotate-45 rounded-[1px] bg-status-warning"
            />
          ) : null}
          <span className="truncate font-medium">{entry.title}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">
            {stateLabel(entry.state, t)}
          </span>
        </span>
        {via ? <span className="truncate text-2xs text-muted-foreground">{via}</span> : null}
        {requiresHome && !finished ? (
          <span className="text-2xs text-muted-foreground">{homeReason}</span>
        ) : null}
      </button>
      {finished ? (
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
          aria-label={actionLabel}
          title={actionLabel}
          onClick={() => {
            onDone()
            requestWorkerTabClose(entry.worktreeId, entry.tab, true)
          }}
        >
          <X className="size-3" />
        </button>
      ) : (
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-disabled:opacity-50"
          aria-label={actionLabel}
          title={requiresHome ? homeReason : actionLabel}
          aria-disabled={requiresHome || undefined}
          aria-description={requiresHome ? homeReason : undefined}
          onClick={() => {
            if (requiresHome) {
              explainWorkerTabHomeStop()
              return
            }
            onDone()
            requestWorkerTabConfirm({ kind: 'stop', worktreeId: entry.worktreeId, tab: entry.tab })
          }}
        >
          <Square className="size-3 fill-current" />
        </button>
      )}
    </div>
  )
}

/** A sibling of the coordinator's tab (never inside role=tab): its count of workers needing you, and their list. */
export function CoordinatorWorkersBadge({
  coordinatorTabId,
  returnFocusTo
}: {
  coordinatorTabId: string
  returnFocusTo: () => HTMLElement | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const count = useAppStore((state) => selectCoordinatorNeedsYouCount(state, coordinatorTabId))
  const requestedOpen = useSyncExternalStore(subscribeOpen, () => openCoordinatorTabId)
  const open = requestedOpen === coordinatorTabId
  const setOpen = useCallback(
    (value: boolean) => openCoordinatorWorkers(value ? coordinatorTabId : null),
    [coordinatorTabId]
  )
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [coordinatorVisible, setCoordinatorVisible] = useState(true)
  useEffect(() => {
    const coordinator = returnFocusTo()
    const strip = coordinator?.closest('.terminal-tab-strip')
    if (count === 0 || !coordinator || !strip) {
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        setCoordinatorVisible(entry?.isIntersecting === true)
      },
      { root: strip }
    )
    observer.observe(coordinator.querySelector('.tab-label') ?? coordinator)
    return () => observer.disconnect()
  }, [count, returnFocusTo])
  const entries = useAppStore((state) =>
    open ? selectCoordinatorWorkers(state, coordinatorTabId) : null
  )
  const hadFocus = useRef(false)
  useEffect(() => {
    // The badge leaves at 0; focus that was on it returns to its coordinator tab.
    if (count === 0 && hadFocus.current) {
      hadFocus.current = false
      returnFocusTo()?.focus()
    }
  }, [count, returnFocusTo])
  const close = useCallback(() => openCoordinatorWorkers(null), [])
  const label = t('workerTabs.badge.label', '{{count}} workers need you', {
    count,
    defaultValue_one: '{{count}} worker needs you'
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className={`flex h-full shrink-0 items-center${count > 0 ? ' pr-1.5' : ''}`}>
          {count > 0 ? (
            <button
              ref={buttonRef}
              type="button"
              aria-label={label}
              title={label}
              aria-haspopup="dialog"
              aria-expanded={open}
              onFocus={() => (hadFocus.current = true)}
              onBlur={() => (hadFocus.current = false)}
              onClick={() => setOpen(!open)}
              className={`flex h-4 min-w-4 flex-none items-center justify-center rounded-full border border-status-warning-border bg-status-warning-background px-1 text-2xs font-semibold text-status-warning-text${coordinatorVisible ? '' : ' invisible'}`}
            >
              {count}
            </button>
          ) : null}
        </span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72"
        aria-label={t('workerTabs.list.title', 'Workers')}
      >
        <div className="px-2 pt-1 pb-1 text-2xs font-semibold text-muted-foreground">
          {t('workerTabs.list.title', 'Workers')}
        </div>
        <div className="max-h-80 overflow-y-auto scrollbar-sleek">
          {(entries ?? []).map((entry) => (
            <WorkerRow key={entry.tab.id} entry={entry} onDone={close} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
