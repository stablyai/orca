import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useDelayedStatus } from '@/hooks/use-delayed-status'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import type { StructuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()

// Why: every launch passes through `starting`; only a slow start deserves the notice.
export const SLOW_STARTUP_NOTICE_DELAY_MS = 5_000

export function NativeChatStructuredSessionStatus(props: {
  sessionId: string
  /** What to call the agent in copy about its process. */
  agentLabel: string
  /** The host's word on the provider child; `starting` is published but not yet answering. */
  startupPhase: 'starting' | 'ready' | null
  startupChildKey: string | number | null
  /** The session's own status row, whose verdict the strip's children read. */
  paneKey: string
  error: string | null
  /** A read the pane is reconnecting on its own: said plainly, not as an error. */
  reconnecting?: boolean
  composerError: string | null
  isVisible: boolean
  backgroundTasks: StructuredSessionBackgroundTasksView
  stopBackgroundTask: (taskId?: string) => Promise<unknown>
}): React.JSX.Element {
  const [stopping, setStopping] = useState<StoppingBackgroundTasks | null>(null)
  const [expanded, setExpanded] = useState<{ sessionId: string; expanded: boolean } | null>(null)
  const activeStopping = stopping?.sessionId === props.sessionId ? stopping : null
  const shownStartupPhase = useDelayedStatus(
    JSON.stringify([props.sessionId, typeof props.startupChildKey, props.startupChildKey]),
    props.startupPhase === 'starting' ? 'starting' : null,
    SLOW_STARTUP_NOTICE_DELAY_MS
  )
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
    void props.stopBackgroundTask(taskId).finally(() => {
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
      {shownStartupPhase === 'starting' ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.native.chat.NativeChatStructuredSessionStatus.starting',
            '{{value0}} is still starting. Messages wait until it is ready; close this chat to give up on it.',
            { value0: props.agentLabel }
          )}
        </p>
      ) : null}
      {props.reconnecting && !props.error ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-muted-foreground">
          {translate('components.native-chat.state.reconnecting', 'Reconnecting to this chat…')}
        </p>
      ) : null}
      {props.error || props.composerError ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-destructive">
          {props.error ?? props.composerError}
        </p>
      ) : null}
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
          stoppingTaskIds={activeStopping?.taskIds ?? NO_STOPPING_TASKS}
          stoppingAll={activeStopping?.all ?? false}
          expanded={expanded?.sessionId === props.sessionId && expanded.expanded}
          onExpandedChange={(value) => setExpanded({ sessionId: props.sessionId, expanded: value })}
          onStop={onStop}
        />
      ) : null}
    </>
  )
}
