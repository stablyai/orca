import { useState } from 'react'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import { NativeChatShellRunList } from '../../shell/NativeChatShellRunList'
import type { NativeChatMessageListHandle } from '../../messages/actions/use-native-chat-reveal-latest'
import type { AgentSessionCancelResult } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  structuredSessionConfirmedStopsStillListed,
  structuredSessionListedTaskRun,
  type StructuredSessionBackgroundTasksView
} from '../../../../../../shared/structured-session-background-tasks-view'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

/** Each confirmed Stop's task, with the run it was pressed on. */
type ConfirmedStops = { sessionId: string; taskIds: ReadonlyMap<string, string> }

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()
const NO_CONFIRMED_STOPS: ReadonlyMap<string, string> = new Map()

export function NativeChatStructuredSessionStatus(props: {
  sessionId: string
  /** The session's own status row, whose verdict the strip's children read. */
  paneKey: string
  isVisible: boolean
  /** The session's background work and its Stop. */
  tasks: {
    backgroundTasks: StructuredSessionBackgroundTasksView
    stopBackgroundTask: (taskId?: string) => Promise<AgentSessionCancelResult | null>
  }
  /** The pane's transcript, where an agent picked in the strip opens. */
  messageListRef?: React.RefObject<NativeChatMessageListHandle | null>
}): React.JSX.Element {
  const [stopping, setStopping] = useState<StoppingBackgroundTasks | null>(null)
  // Keep confirmed Stop buttons pending until that specific run leaves the strip.
  const [confirmed, setConfirmed] = useState<ConfirmedStops | null>(null)
  const [expanded, setExpanded] = useState<{ sessionId: string; expanded: boolean } | null>(null)
  const activeStopping = stopping?.sessionId === props.sessionId ? stopping : null
  const activeConfirmed = confirmed?.sessionId === props.sessionId ? confirmed.taskIds : null
  const confirmedListed = activeConfirmed
    ? structuredSessionConfirmedStopsStillListed(props.tasks.backgroundTasks, activeConfirmed)
    : null
  if (confirmedListed !== activeConfirmed) {
    // A row that left and came back is a task the Stop did not end, so it offers Stop again.
    setConfirmed(
      confirmedListed?.size ? { sessionId: props.sessionId, taskIds: confirmedListed } : null
    )
  }
  const stoppingTaskIds = confirmedListed?.size
    ? new Set([...(activeStopping?.taskIds ?? NO_STOPPING_TASKS), ...confirmedListed.keys()])
    : (activeStopping?.taskIds ?? NO_STOPPING_TASKS)
  const childRowContext = useStructuredSessionChildRowContext(props.paneKey)

  const onStop = (taskId?: string) => {
    const sessionId = props.sessionId
    // A provider may reuse the row's id for the task's next run, which this Stop did not end.
    const run = taskId ? structuredSessionListedTaskRun(props.tasks.backgroundTasks, taskId) : null
    setStopping((current) => {
      const taskIds = new Set(
        current?.sessionId === sessionId ? current.taskIds : NO_STOPPING_TASKS
      )
      if (taskId) {
        taskIds.add(taskId)
      }
      return {
        sessionId,
        taskIds,
        all: taskId ? current?.sessionId === sessionId && current.all : true
      }
    })
    void props.tasks
      .stopBackgroundTask(taskId)
      .then((result) => {
        if (taskId && run !== null && result?.cancelled) {
          setConfirmed((current) => ({
            sessionId,
            taskIds: new Map([
              ...(current?.sessionId === sessionId ? current.taskIds : NO_CONFIRMED_STOPS),
              [taskId, run]
            ])
          }))
        }
      })
      .finally(() => {
        setStopping((current) => {
          if (current?.sessionId !== sessionId) {
            return current
          }
          const taskIds = new Set(current.taskIds)
          if (taskId) {
            taskIds.delete(taskId)
          }
          const all = taskId ? current.all : false
          return taskIds.size === 0 && !all ? null : { sessionId, taskIds, all }
        })
      })
  }

  return (
    <>
      <NativeChatShellRunList sessionId={props.sessionId} />
      {props.tasks.backgroundTasks.show ? (
        <NativeChatBackgroundTasksStatus
          isVisible={props.isVisible}
          tasks={props.tasks.backgroundTasks.tasks}
          settledTasks={props.tasks.backgroundTasks.settledTasks}
          {...(props.tasks.backgroundTasks.children
            ? { childViews: props.tasks.backgroundTasks.children, childRowContext }
            : {})}
          indicatorActive={props.tasks.backgroundTasks.isMonitoring}
          supportsTaskStop={props.tasks.backgroundTasks.supportsStop}
          offersStopAll={props.tasks.backgroundTasks.offersStopAll}
          incomplete={props.tasks.backgroundTasks.incomplete}
          stoppingTaskIds={stoppingTaskIds}
          stoppingAll={activeStopping?.all ?? false}
          expanded={expanded?.sessionId === props.sessionId && expanded.expanded}
          onExpandedChange={(value) => setExpanded({ sessionId: props.sessionId, expanded: value })}
          onStop={onStop}
          onShowAgent={(providerId) => props.messageListRef?.current?.revealSubagent(providerId)}
        />
      ) : null}
    </>
  )
}
