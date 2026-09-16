import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Activity, Bot, ChevronDown, CircleHelp, SquareTerminal, Workflow } from 'lucide-react'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { backgroundTasksHeaderContent } from './background-task-header-content'
import {
  backgroundTaskElapsedLabel,
  backgroundTaskGroupLabel,
  backgroundTaskStateReason,
  buildBackgroundTaskGroups,
  formatBackgroundTaskTokens,
  type BackgroundRosterTask
} from './background-task-roster'

/** Below this strip width (border-box, live root font size) the header drops
 *  its per-kind breakdown for an honest total. A narrow split pane on a wide
 *  monitor must behave like a narrow window, so no viewport media query. */
const NARROW_STRIP_REM = 24

function rootFontSizePx(): number {
  const parsed = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16
}

/** Observe the strip's own border-box width; the viewport is only the
 *  pre-measurement stand-in before the first observer callback. */
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

const KIND_ICONS = {
  agent: Bot,
  command: SquareTerminal,
  monitor: Activity,
  workflow: Workflow,
  unknown: CircleHelp
} as const

/** Monitoring is a STATE the app colours the same on every surface — the agent
 *  sidebar and `AgentStateDot` both draw an amber heartbeat — so the strip must
 *  match it or the two stop reading as the same thing. The other four are plain
 *  kind markers and stay neutral. `dimmed` is the running-turn treatment. */
function kindIconTone(kind: AgentSessionBackgroundTask['kind'], dimmed: boolean): string {
  const tone = kind === 'monitor' ? 'text-yellow-500' : 'text-muted-foreground'
  return dimmed ? `${tone}/40` : tone
}

/** Absent means stoppable: a host predating the field published only rows its
 *  stop could act on, so reading absence as "not stoppable" would hide a
 *  working control. Only an explicit `false` withholds the button — Claude
 *  marks its in-turn foreground rows that way, and a Stop on one of those
 *  resolves to an empty target list and silently reports nothing cancelled. */
function backgroundTaskStoppable(task: AgentSessionBackgroundTask): boolean {
  return task.stoppable !== false
}

function BackgroundTaskRow(props: {
  entry: BackgroundRosterTask
  now: number
  supportsTaskStop: boolean
  stopping: boolean
  onStop: (taskId: string) => void
}): React.JSX.Element {
  const { entry, now } = props
  const Icon = KIND_ICONS[entry.task.kind]
  // Every attention state states its reason on the row, the same ones the collapsed
  // header names; `unverifiable` ("no contact") must never be silently dropped.
  const reason = backgroundTaskStateReason(entry.state)
  // Settled rows keep their final usage but no elapsed — a still-growing clock
  // on finished work would lie.
  const meta = [
    entry.task.totalTokens !== undefined
      ? formatBackgroundTaskTokens(entry.task.totalTokens)
      : null,
    entry.settled ? null : backgroundTaskElapsedLabel(entry.task, now)
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 text-foreground/80">
      <Icon
        aria-hidden="true"
        className={`size-3.5 shrink-0 ${kindIconTone(entry.task.kind, false)}`}
      />
      <AgentStateDot state={entry.state} size="sm" title={null} />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{entry.name}</span>
        {reason ? <span className="text-muted-foreground"> · {reason}</span> : null}
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {!entry.settled && props.supportsTaskStop && backgroundTaskStoppable(entry.task) ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={translate(
            'components.native-chat.backgroundTasks.stopTask',
            'Stop {{value0}}',
            {
              value0: entry.name
            }
          )}
          disabled={props.stopping}
          onClick={() => props.onStop(entry.task.id)}
        >
          {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
        </Button>
      ) : null}
    </li>
  )
}

export function NativeChatBackgroundTasksStatus(props: {
  tasks: readonly AgentSessionBackgroundTask[]
  settledTasks: readonly AgentSessionBackgroundTask[]
  supportsTaskStop: boolean
  /** False when the provider exposes no honest stop at all; the fallback
   *  control is hidden rather than offering a button that cannot act. */
  supportsStopAll: boolean
  stoppingTaskIds: ReadonlySet<string>
  stoppingAll: boolean
  /** True while the session is idle: only then may the strip speak as the
   *  animated monitoring indicator. A running turn owns the voice. */
  indicatorActive: boolean
  isVisible: boolean
  /** Owned by the parent. The strip is mounted on live work, so it disappears
   *  and comes back whenever the roster momentarily empties between two pieces
   *  of a sequential fan-out — settled rows are flushed at that same instant
   *  and hold nothing open — and local state would collapse the list on every
   *  such gap. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onStop: (taskId?: string) => void
}): React.JSX.Element {
  const expanded = props.expanded
  const taskListId = useId()
  const stripRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrowStrip(stripRef)
  // The 1 Hz elapsed tick must not re-group, re-sort and re-translate the whole roster.
  const groups = useMemo(
    () => buildBackgroundTaskGroups(props.tasks, props.settledTasks),
    [props.tasks, props.settledTasks]
  )
  const singleLiveCommand =
    groups.length === 1 && groups[0].kind === 'command' && groups[0].tasks.length === 1
  const hasElapsed = groups.some((group) =>
    group.tasks.some((entry) => !entry.settled && (entry.task.startedAt ?? 0) > 0)
  )
  const now = useNow(1_000, props.isVisible && hasElapsed && (expanded || singleLiveCommand))
  const header = backgroundTasksHeaderContent(groups, { narrow, now })
  const headerText = `${header.segments.map((segment) => segment.text).join(' · ')}${header.detail ? `${header.segments.length > 0 ? ' — ' : ''}${header.detail}` : ''}`
  return (
    <div
      data-native-chat-background-tasks="true"
      className="shrink-0 bg-background px-3 pt-2 sm:px-4"
    >
      <div
        ref={stripRef}
        className="mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground shadow-xs"
      >
        <div className="flex h-8 items-center px-1.5">
          <button
            type="button"
            className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
                    {/* A text token, not `--border`: that one is a divider line
                        (7% white in dark) and reads as invisible at this size. */}
                    {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
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
                    <span className="font-medium text-foreground">{segment.text}</span>
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
              className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
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
                  <p className="px-0.5 pb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {backgroundTaskGroupLabel(group.kind)}
                  </p>
                  <ul
                    role="list"
                    aria-label={backgroundTaskGroupLabel(group.kind)}
                    className="space-y-0.5"
                  >
                    {group.tasks.map((entry) => (
                      <BackgroundTaskRow
                        key={entry.task.id}
                        entry={entry}
                        now={now}
                        supportsTaskStop={props.supportsTaskStop}
                        stopping={props.stoppingTaskIds.has(entry.task.id)}
                        onStop={props.onStop}
                      />
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p>
                {translate(
                  'components.native-chat.backgroundTasks.detailsUnavailable',
                  'Task details are unavailable for this session.'
                )}
              </p>
            )}
            {!props.supportsTaskStop && props.supportsStopAll ? (
              <div className={groups.length > 0 ? 'mt-2 border-t border-border pt-2' : 'mt-2'}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={translate(
                    'components.native-chat.backgroundTasks.stopAll',
                    'Stop background tasks'
                  )}
                  disabled={props.stoppingAll}
                  onClick={() => props.onStop()}
                >
                  {translate('components.native-chat.backgroundTasks.stop', 'Stop')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
