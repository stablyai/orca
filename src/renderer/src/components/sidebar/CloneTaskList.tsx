import React from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { CloneTaskRow } from './CloneTaskRow'

/**
 * Renders backgrounded clone tasks above the project list. Only tasks handed off
 * from the Add-Repo dialog (backgrounded) surface here — an open dialog shows its
 * own in-progress view, so this avoids a duplicate row.
 */
export function CloneTaskList(): React.JSX.Element | null {
  const taskIds = useAppStore(
    useShallow((s) =>
      Object.values(s.cloneTasksById)
        .filter((task) => task.backgrounded)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((task) => task.id)
    )
  )
  if (taskIds.length === 0) {
    return null
  }
  return (
    <div className="flex flex-col gap-1 px-2 pb-1.5">
      {taskIds.map((taskId) => (
        <CloneTaskRow key={taskId} taskId={taskId} />
      ))}
    </div>
  )
}
