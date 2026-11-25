import { useEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentChildRowModel } from '../../../../../shared/agent-status/presentation/agent-child-row-model'
import { backgroundTaskRowStopId } from '../../../../../shared/agent-status/presentation/background-tasks/background-task-roster'
import type { StructuredSessionBackgroundTasksView } from '../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import { structuredSessionBackgroundTaskGroups } from '../tools/tasks/background-task-roster'
import { sayBackgroundTaskTranslated as sayTask } from '../tools/tasks/background-task-words-text'
import { useStructuredSessionChildRowContext } from '../tools/tasks/use-structured-session-child-row-context'
import type { StructuredSessionTaskStop } from '../tools/tasks/use-structured-session-task-stop'
import { NATIVE_CHAT_SUBAGENT_SHEET_CLOSE_ATTRIBUTE } from './native-chat-open-subagent'

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

/** A structured chat's Stop for its open subagent: the agents strip's own Stop for that row, while it has one. */
export function NativeChatStructuredSubagentStop({
  agentId,
  paneKey,
  backgroundTasks,
  stop
}: {
  agentId: string
  paneKey: string
  backgroundTasks: StructuredSessionBackgroundTasksView
  stop: StructuredSessionTaskStop
}): React.JSX.Element | null {
  const t = useTranslate()
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
  const stopping = stopId !== null && stop.stoppingTaskIds.has(stopId)
  const anchorRef = useRef<HTMLSpanElement>(null)
  // A Stop that ends or disables drops focus with it; the sheet's Close takes it.
  useEffect(() => {
    const active = document.activeElement
    if (active === null || active === document.body) {
      anchorRef.current
        ?.closest('[role="dialog"]')
        ?.querySelector<HTMLElement>(`[${NATIVE_CHAT_SUBAGENT_SHEET_CLOSE_ATTRIBUTE}]`)
        ?.focus({ preventScroll: true })
    }
  }, [stopId, stopping])
  return (
    <span ref={anchorRef} className="contents">
      {stopId === null ? null : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={stopping}
          onClick={() => stop.onStop(stopId)}
        >
          {stopping ? t('components.native-chat.status.stopping', 'Stopping…') : sayTask('stop')}
        </Button>
      )}
    </span>
  )
}
