import { useCallback, useContext, useRef } from 'react'
import { chatViewRetention } from '../../pane/routing/native-chat-view-retention'
import { NativeChatViewTabContext } from '../../pane/ownership/native-chat-view-memory'
import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'

/**
 * An open edit holds the host's delivery, so its chat view stays mounted until Save or Cancel ends it. Taken and
 * released as the edit opens and closes rather than in an effect, which a hidden chat would not run.
 */
export function useNativeChatQueuedEditViewHold(): (open: boolean) => void {
  const viewTab = useContext(NativeChatViewTabContext)
  const releaseHold = useRef<(() => void) | null>(null)
  useNativeChatPaneLifetimeEffect(
    useCallback(
      () => () => {
        releaseHold.current?.()
        releaseHold.current = null
      },
      []
    )
  )
  return useCallback(
    (open: boolean) => {
      if (open && !releaseHold.current && viewTab) {
        releaseHold.current = chatViewRetention.hold(viewTab.tabId)
      } else if (!open && releaseHold.current) {
        releaseHold.current()
        releaseHold.current = null
      }
    },
    [viewTab]
  )
}
