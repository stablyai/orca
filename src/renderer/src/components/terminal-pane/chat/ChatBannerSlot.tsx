import './chat-banner-slot.css'
import type React from 'react'
import { useCallback } from 'react'
import { readChatBannerSlot, setChatBannerSlot } from './chat-banner-slot'

/** The top of a terminal tab's chat column: the pane's banners portal here while it is open. */
export function ChatBannerSlot({ paneKey }: { paneKey: string }): React.JSX.Element {
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        return
      }
      setChatBannerSlot(paneKey, element)
      return () => {
        // Why check: a remount can register its new slot before this one's cleanup runs.
        if (readChatBannerSlot(paneKey) === element) {
          setChatBannerSlot(paneKey, null)
        }
      }
    },
    [paneKey]
  )
  return <div ref={ref} data-chat-banner-slot="" className="shrink-0" />
}
