import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  getWakeInputCount,
  getWakeInputVersion,
  isWorkspaceWaking,
  subscribeWakeInput,
  subscribeWakeInputDropped
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

/** A toast when typing held during a wake was not sent (it otherwise reaches the shell as typed). */
export function useWakeInputNotices(workspaceId: string): void {
  const t = useTranslate()
  useEffect(() => {
    const offDropped = subscribeWakeInputDropped((dropped) => {
      if (dropped.workspaceId === workspaceId) {
        toast(t('orcaCloudWorkspace.typingNotSent', 'Your typing wasn’t sent.'))
      }
    })
    return offDropped
  }, [workspaceId, t])
}
