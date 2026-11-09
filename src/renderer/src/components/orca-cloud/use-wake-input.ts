import { useSyncExternalStore } from 'react'
import {
  getWakeInputPreview,
  getWakeInputVersion,
  isWorkspaceWaking,
  subscribeWakeInput
} from '@/components/terminal-pane/input/wake-input-buffer'

/** Whether typing into this workspace is being held for its woken terminal, and what is held. */
export function useWakeInput(workspaceId: string): { waking: boolean; pending: string } {
  // Read through the snapshot version: the compiler memoizes plain calls on their arguments, so
  // the reads must depend on the store version to see new typing.
  const version = useSyncExternalStore(subscribeWakeInput, getWakeInputVersion)
  return readWakeInput(workspaceId, version)
}

function readWakeInput(
  workspaceId: string,
  _version: number
): { waking: boolean; pending: string } {
  return { waking: isWorkspaceWaking(workspaceId), pending: getWakeInputPreview(workspaceId) }
}
