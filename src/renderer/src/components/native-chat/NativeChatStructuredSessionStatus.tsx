import { useState } from 'react'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import type { AgentSessionCancelResult } from '../../../../shared/agent-session-wire'
import {
  structuredSessionConfirmedStopsStillListed,
  type StructuredSessionBackgroundTasksView
} from '../../../../shared/structured-session-background-tasks-view'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

type ConfirmedStops = { sessionId: string; taskIds: ReadonlySet<string> }

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()

export function NativeChatStructuredSessionStatus(props: {
  sessionId: string
  /** The session's own status row, whose verdict the strip's children read. */
  paneKey: string
  isVisible: boolean
  backgroundTasks: StructuredSessionBackgroundTasksView
  stopBackgroundTask: (taskId?: string) => Promise<AgentSessionCancelResult | null>
}): React.JSX.Element {
  const [stopping, setStopping] = useState<StoppingBackgroundTasks | null>(null)
  // Stops the host confirmed: each row keeps its stopping button until it leaves the strip.
  const [confirmed, setConfirmed] = useState<ConfirmedStops | null>(null)
  const [expanded, setExpanded] = useState<{ sessionId: string; expanded: boolean } | null>(null)
  const activeStopping = stopping?.sessionId === props.sessionId ? stopping : null
  const activeConfirmed = confirmed?.sessionId === props.sessionId ? confirmed.taskIds : null
  const confirmedListed = activeConfirmed
    ? structuredSessionConfirmedStopsStillListed(props.backgroundTasks, activeConfirmed)
    : null
  if (confirmedListed !== activeConfirmed) {
    // A row that left and came back is a task the Stop did not end, so it offers Stop again.
    setConfirmed(
      confirmedListed?.size ? { sessionId: props.sessionId, taskIds: confirmedListed } : null
    )
  }
  const stoppingTaskIds = confirmedListed?.size
    ? new Set([...(activeStopping?.taskIds ?? NO_STOPPING_TASKS), ...confirmedListed])
    : (activeStopping?.taskIds ?? NO_STOPPING_TASKS)
  const childRowContext = useStructuredSessionChildRowContext(props.paneKey)

  const onStop = (taskId?: string) => {
    const sessionId = props.sessionId
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
    void props
      .stopBackgroundTask(taskId)
      .then((result) => {
        if (taskId && result?.cancelled) {
          setConfirmed((current) => ({
            sessionId,
            taskIds: new Set([
              ...(current?.sessionId === sessionId ? current.taskIds : NO_STOPPING_TASKS),
              taskId
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
      {props.backgroundTasks.show ? (
        <NativeChatBackgroundTasksStatus
          isVisible={props.isVisible}
          tasks={props.backgroundTasks.tasks}
          settledTasks={props.backgroundTasks.settledTasks}
          {...(props.backgroundTasks.children
            ? { childViews: props.backgroundTasks.children, childRowContext }
            : {})}
          indicatorActive={props.backgroundTasks.isMonitoring}
          supportsTaskStop={props.backgroundTasks.supportsStop}
          supportsStopAll={props.backgroundTasks.supportsStopAll}
          stoppingTaskIds={stoppingTaskIds}
          stoppingAll={activeStopping?.all ?? false}
          expanded={expanded?.sessionId === props.sessionId && expanded.expanded}
          onExpandedChange={(value) => setExpanded({ sessionId: props.sessionId, expanded: value })}
          onStop={onStop}
        />
      ) : null}
    </>
  )
}
