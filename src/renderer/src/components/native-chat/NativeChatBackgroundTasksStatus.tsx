import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Activity, Bot, ChevronDown, CircleHelp, SquareTerminal, Workflow } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import type {
  AgentChildRowContext,
  AgentChildRowModel
} from '../../../../shared/agent-child-row-model'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import { AgentChildRowContent } from '@/components/AgentChildRowContent'
import { agentChildRowName } from '@/components/agent-child-row-text'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import {
  backgroundTasksHeaderText,
  NARROW_BACKGROUND_TASKS_STRIP_REM
} from '../../../../shared/background-task-header-content'
import {
  backgroundTaskRowMeta,
  backgroundTaskRowStopId,
  backgroundTasksStripTicks,
  buildBackgroundTaskGroupsFromViews,
  type BackgroundTaskGroup
} from '../../../../shared/background-task-roster'
import { backgroundTasksHeaderContent } from './background-task-header-content'
import { backgroundTaskGroupLabel, buildBackgroundTaskGroups } from './background-task-roster'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

/** Use strip width in rem so narrow splits behave like narrow windows even on wide monitors. */
const NARROW_STRIP_REM = NARROW_BACKGROUND_TASKS_STRIP_REM

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16
}

/** Measure the strip itself; viewport width is only the initial fallback. */
function useNarrowStrip(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_STRIP_REM * 16)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver((observerEntries) => {
      const width =
        observerEntries[0]?.borderBoxSize?.[0]?.inlineSize ?? element.getBoundingClientRect().width
      setNarrow(width < NARROW_STRIP_REM * rootFontSizePx())
    })
    observer.observe(element, { box: 'border-box' })
    return () => observer.disconnect()
  }, [ref])
  return narrow
}

export const KIND_ICONS = {
  agent: Bot,
  command: SquareTerminal,
  monitor: Activity,
  workflow: Workflow,
  unknown: CircleHelp
} as const

/** Match the sidebar’s amber monitoring state; other kind icons stay neutral, and running turns dim the strip. */
function kindIconTone(kind: AgentSessionBackgroundTask['kind'], dimmed: boolean): string {
  const tone = kind === 'monitor' ? 'text-yellow-500' : 'text-muted-foreground'
  return dimmed ? `${tone}/40` : tone
}

function BackgroundTaskRow(props: {
  row: AgentChildRowModel
  now: number
  supportsTaskStop: boolean
  stoppingTaskIds: ReadonlySet<string>
  onStop: (taskId: string) => void
}): React.JSX.Element {
  const { row, now } = props
  const Icon = KIND_ICONS[row.kind]
  const meta = backgroundTaskRowMeta(row, now)
  const stopId = backgroundTaskRowStopId(row, props.supportsTaskStop)
  return (
    <>
      <li className="flex h-6 min-w-0 items-center gap-2 text-foreground">
        <Icon aria-hidden="true" className={`size-3.5 shrink-0 ${kindIconTone(row.kind, false)}`} />
        {/* Every attention state states its reason on the row; `unverifiable` is never dropped. */}
        <AgentChildRowContent
          row={row}
          now={now}
          leadClassName="font-medium text-foreground"
          trailClassName="text-muted-foreground"
          separator=" · "
          dotTitle={null}
        />
        {meta ? (
          <span className="shrink-0 font-mono text-3xs tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
        {stopId !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={say('stopTask', { value0: agentChildRowName(row) })}
            disabled={props.stoppingTaskIds.has(stopId)}
            onClick={() => props.onStop(stopId)}
          >
            {say('stop')}
          </Button>
        ) : null}
      </li>
      {row.owned.length > 0 ? (
        // Work a child owns (its shell, a nested agent) reads beneath it, not in its kind's group.
        <li>
          <ul role="list" className="ml-5 space-y-0.5">
            {row.owned.map((owned) => (
              <BackgroundTaskRow
                key={owned.id}
                row={owned}
                now={now}
                supportsTaskStop={props.supportsTaskStop}
                stoppingTaskIds={props.stoppingTaskIds}
                onStop={props.onStop}
              />
            ))}
          </ul>
        </li>
      ) : null}
    </>
  )
}

export function NativeChatBackgroundTasksStatus(props: {
  tasks: readonly AgentSessionBackgroundTask[]
  settledTasks: readonly AgentSessionBackgroundTask[]
  /** The host's child views, when it publishes them; rows then read these instead of the tasks. */
  childViews?: readonly AgentChildWorkView[]
  /** Use the sidebar’s parent context to qualify child state; without it, trust reported live claims. */
  childRowContext?: AgentChildRowContext
  supportsTaskStop: boolean
  /** Offer untargeted Stop only when the provider can perform it. */
  offersStopAll: boolean
  /** Some running work is not listed, so the rows are not the whole roster. */
  incomplete?: boolean
  stoppingTaskIds: ReadonlySet<string>
  stoppingAll: boolean
  /** Let monitoring speak only when idle; a running turn owns the indicator. */
  indicatorActive: boolean
  isVisible: boolean
  /** Parent-owned expansion survives temporary empty rosters, which unmount this strip and flush settled rows. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onStop: (taskId?: string) => void
}): React.JSX.Element {
  const expanded = props.expanded
  const taskListId = useId()
  const stripRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrowStrip(stripRef)
  // The 1 Hz elapsed tick must not re-group, re-sort and re-translate the whole roster.
  const groups: BackgroundTaskGroup[] = useMemo(
    () =>
      props.childViews !== undefined
        ? buildBackgroundTaskGroupsFromViews(props.childViews, props.childRowContext)
        : buildBackgroundTaskGroups(props.tasks, props.settledTasks),
    [props.childViews, props.childRowContext, props.tasks, props.settledTasks]
  )
  const now = useNow(1_000, props.isVisible && backgroundTasksStripTicks(groups, expanded))
  const header = backgroundTasksHeaderContent(groups, { narrow, now })
  const headerText = backgroundTasksHeaderText(header)
  return (
    <div
      data-native-chat-background-tasks="true"
      className="group/tasks shrink-0 bg-chat-canvas px-3 pt-2 sm:px-4"
    >
      {/* When the goal tab is the next sibling, take its width and share its top edge. */}
      <div className="mx-auto w-full max-w-(--chat-content-max-width) [[data-native-chat-background-tasks]:has(+[data-native-chat-thread-goal])_&]:px-2">
        <div
          ref={stripRef}
          className="overflow-hidden rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs [[data-native-chat-background-tasks]:has(+[data-native-chat-thread-goal])_&]:rounded-b-none [[data-native-chat-background-tasks]:has(+[data-native-chat-thread-goal])_&]:shadow-none"
        >
          <div className="flex h-8 items-center px-1.5">
            <button
              type="button"
              className="group/task-header flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
              aria-expanded={expanded}
              aria-controls={taskListId}
              aria-label={headerText}
              onClick={() => props.onExpandedChange(!expanded)}
            >
              <span className="min-w-0 truncate">
                {header.segments.map((segment, index) => {
                  // A collapsed total spans kinds, so no single icon can stand for it.
                  const kind = segment.kind
                  const Icon = kind ? KIND_ICONS[kind] : null
                  return (
                    <span key={segment.kind ?? 'total'}>
                      {/* Use text color; the border token is too faint for a readable separator. */}
                      {index > 0 ? (
                        <span className="text-muted-foreground group-hover/task-header:text-accent-foreground">
                          {' · '}
                        </span>
                      ) : null}
                      {Icon && kind ? (
                        <Icon
                          aria-hidden="true"
                          // The turn owns the voice: same icons, dimmed until it ends.
                          className={`mr-1 inline size-3 align-[-0.125em] ${kindIconTone(
                            kind,
                            !props.indicatorActive
                          )}`}
                        />
                      ) : null}
                      <span className="font-medium text-foreground group-hover/task-header:text-accent-foreground">
                        {segment.text}
                      </span>
                    </span>
                  )
                })}
                {header.detail ? (
                  <span>
                    {header.segments.length > 0 ? ' — ' : null}
                    {header.detail}
                  </span>
                ) : null}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={`size-3 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
          {expanded ? (
            <div
              id={taskListId}
              className="scrollbar-sleek max-h-40 overflow-y-auto border-t border-border px-3 py-2"
            >
              {groups.length > 0 ? (
                groups.map((group, index) => (
                  <div
                    key={group.kind}
                    className={index > 0 ? 'mt-1.5 border-t border-border/60 pt-1.5' : ''}
                  >
                    <p className="px-0.5 pb-1 font-mono text-3xs uppercase tracking-wider text-muted-foreground">
                      {backgroundTaskGroupLabel(group.kind)}
                    </p>
                    <ul
                      role="list"
                      aria-label={backgroundTaskGroupLabel(group.kind)}
                      className="space-y-0.5"
                    >
                      {group.tasks.map((entry) => (
                        <BackgroundTaskRow
                          key={entry.row.id}
                          row={entry.row}
                          now={now}
                          supportsTaskStop={props.supportsTaskStop}
                          stoppingTaskIds={props.stoppingTaskIds}
                          onStop={props.onStop}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              ) : (
                <p>{say('detailsUnavailable')}</p>
              )}
              {props.incomplete && groups.length > 0 ? (
                <p className="mt-1.5">{say('detailsUnavailable')}</p>
              ) : null}
              {props.offersStopAll ? (
                <div className={groups.length > 0 ? 'mt-2 border-t border-border pt-2' : 'mt-2'}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-label={say('stopAll')}
                    disabled={props.stoppingAll}
                    onClick={() => props.onStop()}
                  >
                    {say('stop')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
