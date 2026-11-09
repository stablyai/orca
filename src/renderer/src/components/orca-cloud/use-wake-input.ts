import { useSyncExternalStore } from 'react'
import {
  getWakeInputCount,
  getWakeInputVersion,
  isWorkspaceWaking,
  subscribeWakeInput
} from '@/components/terminal-pane/input/wake-input-buffer'

/** Whether typing into this workspace is being held for its woken terminal, and how much. */
export function useWakeInput(workspaceId: string): { waking: boolean; pending: number } {
  // Read through the snapshot version: the compiler memoizes plain calls on their arguments, so
  // the reads must depend on the store version to see new typing.
  const version = useSyncExternalStore(subscribeWakeInput, getWakeInputVersion)
  return readWakeInput(workspaceId, version)
}

function readWakeInput(
  workspaceId: string,
  _version: number
): { waking: boolean; pending: number } {
  return { waking: isWorkspaceWaking(workspaceId), pending: getWakeInputCount(workspaceId) }
}
