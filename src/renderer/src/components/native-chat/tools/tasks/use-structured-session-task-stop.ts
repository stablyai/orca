import { useState } from 'react'
import type { AgentSessionCancelResult } from '../../../../../../shared/agent-session/agent-session-wire'
import {
  structuredSessionConfirmedStopsStillListed,
  structuredSessionListedTaskRun,
  type StructuredSessionBackgroundTasksView
} from '../../../../../../shared/structured-session-background-tasks-view'

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

/** Each confirmed Stop's task, with the run it was pressed on. */
type ConfirmedStops = { sessionId: string; taskIds: ReadonlyMap<string, string> }

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()
const NO_CONFIRMED_STOPS: ReadonlyMap<string, string> = new Map()

/** The session's background-work Stop, shared by the agents strip and an open subagent's bar. */
export type StructuredSessionTaskStop = {
  stoppingTaskIds: ReadonlySet<string>
  stoppingAll: boolean
  onStop: (taskId?: string) => void
}

export function useStructuredSessionTaskStop(
  sessionId: string,
  tasks: {
    backgroundTasks: StructuredSessionBackgroundTasksView
    stopBackgroundTask: (taskId?: string) => Promise<AgentSessionCancelResult | null>
  }
): StructuredSessionTaskStop {
  const [stopping, setStopping] = useState<StoppingBackgroundTasks | null>(null)
  // Keep confirmed Stop buttons pending until that specific run leaves the strip.
  const [confirmed, setConfirmed] = useState<ConfirmedStops | null>(null)
  const activeStopping = stopping?.sessionId === sessionId ? stopping : null
  const activeConfirmed = confirmed?.sessionId === sessionId ? confirmed.taskIds : null
  const confirmedListed = activeConfirmed
    ? structuredSessionConfirmedStopsStillListed(tasks.backgroundTasks, activeConfirmed)
    : null
  if (confirmedListed !== activeConfirmed) {
    // A row that left and came back is a task the Stop did not end, so it offers Stop again.
    setConfirmed(confirmedListed?.size ? { sessionId, taskIds: confirmedListed } : null)
  }
  const stoppingTaskIds = confirmedListed?.size
    ? new Set([...(activeStopping?.taskIds ?? NO_STOPPING_TASKS), ...confirmedListed.keys()])
    : (activeStopping?.taskIds ?? NO_STOPPING_TASKS)

  const onStop = (taskId?: string) => {
    // A provider may reuse the row's id for the task's next run, which this Stop did not end.
    const run = taskId ? structuredSessionListedTaskRun(tasks.backgroundTasks, taskId) : null
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
    void tasks
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

  return { stoppingTaskIds, stoppingAll: activeStopping?.all ?? false, onStop }
}
