import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import {
  getWakeInputCount,
  getWakeInputVersion,
  isWorkspaceWaking,
  subscribeWakeInput,
  subscribeWakeInputDelivered,
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

/** Toasts for typing held during a wake: it is on the prompt (press Enter), or it was not sent. */
export function useWakeInputNotices(workspaceId: string): void {
  const t = useTranslate()
  useEffect(() => {
    const offDelivered = subscribeWakeInputDelivered((delivery) => {
      if (delivery.workspaceId === workspaceId && delivery.submitted) {
        // Enter is never replayed into the woken terminal: the person runs it after a look.
        toast(
          t(
            'orcaCloudWorkspace.typedWhileWaking',
            'What you typed is on the prompt. Press Enter to run it.'
          )
        )
      }
    })
    const offDropped = subscribeWakeInputDropped((dropped) => {
      if (dropped.workspaceId === workspaceId) {
        toast(t('orcaCloudWorkspace.typingNotSent', 'Your typing wasn’t sent.'))
      }
    })
    return () => {
      offDelivered()
      offDropped()
    }
  }, [workspaceId, t])
}
