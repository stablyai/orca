import { useMemo } from 'react'

type WorktreeParkTerminalAssignment = {
  unifiedTabId: string
  groupId: string
  isActiveInGroup: boolean
}

function getTerminalParkingAssignmentsKey(
  assignments: ReadonlyMap<string, WorktreeParkTerminalAssignment>
): string {
  return JSON.stringify(
    Array.from(assignments, ([tabId, assignment]) => [
      tabId,
      assignment.unifiedTabId,
      assignment.groupId,
      assignment.isActiveInGroup
    ])
  )
}

export function useWorktreeParkTerminalAssignments(
  assignments: ReadonlyMap<string, WorktreeParkTerminalAssignment>,
  coldParkTerminalPanes: boolean
): ReadonlyMap<string, WorktreeParkTerminalAssignment> {
  const parkingAssignmentsKey = coldParkTerminalPanes
    ? getTerminalParkingAssignmentsKey(assignments)
    : assignments
  // eslint-disable-next-line react-hooks/exhaustive-deps -- decorative unified labels must not retrigger dominated pre-gate work.
  return useMemo(() => assignments, [parkingAssignmentsKey])
}
