import { useMemo } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import {
  formatSubagentTokens,
  subagentStateLabel
} from '../../../../../shared/native-chat/transcript/native-chat-subagent-group-header'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import type { AgentChildRowModel } from '../../../../../shared/agent-status/presentation/agent-child-row-model'
import { backgroundTaskRowStopId } from '../../../../../shared/background-task-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/structured-session-background-tasks-view'
import { structuredSessionBackgroundTaskGroups } from '../tools/tasks/background-task-roster'
import { sayBackgroundTaskTranslated as sayTask } from '../tools/tasks/background-task-words-text'
import { useStructuredSessionChildRowContext } from '../tools/tasks/use-structured-session-child-row-context'
import type { StructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { StatusDot, SubagentElapsed } from './NativeChatSubagentRun'
import { sayNativeChatSubagentGroupTranslated as say } from './native-chat-subagent-group-words-text'

/** Stands in for the composer while a subagent's view is open: its state, its Stop, and the way back. */
export function NativeChatSubagentStatusBar({
  entry,
  stop,
  onBack
}: {
  entry: NativeChatSubagentEntry | undefined
  /** Present while the agents strip could stop this subagent. */
  stop?: { stopping: boolean; onStop: () => void }
  onBack: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = entry ? normalizeSubagentState(entry.state) : null
  return (
    <div className="shrink-0 bg-chat-pane px-3 pt-2 pb-4 sm:px-4">
      <div className="mx-auto flex h-10 w-full max-w-(--chat-content-max-width) min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 text-xs text-muted-foreground shadow-xs">
        {state ? (
          <span className="flex min-w-0 items-center gap-1.5 tabular-nums">
            <StatusDot state={state} pulsing={state === 'working'} />
            <span className="shrink-0 font-medium text-foreground">
              {subagentStateLabel(state, 1, 1, say)}
            </span>
            {entry?.startedAt !== undefined ? (
              // Ticking digits stay out of live announcements.
              <span aria-hidden={state === 'working' || undefined} className="truncate">
                {' · '}
                <SubagentElapsed
                  startedAt={entry.startedAt}
                  settledAt={entry.settledAt ?? null}
                  counting={state === 'working'}
                />
              </span>
            ) : null}
            {typeof entry?.tokens === 'number' ? (
              <span className="truncate">{` · ${formatSubagentTokens(entry.tokens)}`}</span>
            ) : null}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {stop ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={stop.stopping}
              onClick={stop.onStop}
            >
              {sayTask('stop')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="xs" onClick={onBack}>
            <ChevronLeft aria-hidden />
            {t('components.native-chat.subagents.backToMain', 'Back to main agent')}
          </Button>
        </span>
      </div>
    </div>
  )
}

function rowFor(
  rows: readonly AgentChildRowModel[],
  providerId: string
): AgentChildRowModel | undefined {
  for (const row of rows) {
    const found = row.providerId === providerId ? row : rowFor(row.owned, providerId)
    if (found) {
      return found
    }
  }
  return undefined
}

/** A structured chat's bar: the roster's entry for the agent, with the agents strip's own Stop. */
export function NativeChatStructuredSubagentStatusBar({
  agentId,
  entry,
  paneKey,
  backgroundTasks,
  stop,
  onBack
}: {
  agentId: string
  entry: NativeChatSubagentEntry | undefined
  paneKey: string
  backgroundTasks: StructuredSessionBackgroundTasksView
  stop: StructuredSessionTaskStop
  onBack: () => void
}): React.JSX.Element {
  const childRowContext = useStructuredSessionChildRowContext(paneKey)
  const { tasks, settledTasks, children, supportsStop } = backgroundTasks
  const stopId = useMemo(() => {
    const rows = structuredSessionBackgroundTaskGroups(
      tasks,
      settledTasks,
      children,
      childRowContext
    ).flatMap((group) => group.tasks.map(({ row }) => row))
    const row = rowFor(rows, agentId)
    return row ? backgroundTaskRowStopId(row, supportsStop) : null
  }, [agentId, childRowContext, children, settledTasks, supportsStop, tasks])
  const { onStop, stoppingTaskIds } = stop
  return (
    <NativeChatSubagentStatusBar
      entry={entry}
      stop={
        stopId === null
          ? undefined
          : { stopping: stoppingTaskIds.has(stopId), onStop: () => onStop(stopId) }
      }
      onBack={onBack}
    />
  )
}
