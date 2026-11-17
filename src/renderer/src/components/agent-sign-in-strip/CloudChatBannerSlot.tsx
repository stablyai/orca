import './cloud-chat-banner-slot.css'
import type React from 'react'
import { useCallback } from 'react'
import { readCloudChatBannerSlot, setCloudChatBannerSlot } from './cloud-chat-banner-slot'

/** The top of a terminal tab's chat column: the pane's cloud banners portal here while it is open. */
export function CloudChatBannerSlot({ paneKey }: { paneKey: string }): React.JSX.Element {
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        return
      }
      setCloudChatBannerSlot(paneKey, element)
      return () => {
        // Why check: a remount can register its new slot before this one's cleanup runs.
        if (readCloudChatBannerSlot(paneKey) === element) {
          setCloudChatBannerSlot(paneKey, null)
        }
      }
    },
    [paneKey]
  )
  return <div ref={ref} data-cloud-chat-banners="" className="shrink-0" />
}

/** A bridge chat with its pane's cloud banners above it, shown while the chat covers the pane. */
export function CloudChatBannerFrame({
  paneKey,
  children
}: {
  paneKey: string | undefined
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {paneKey ? <CloudChatBannerSlot paneKey={paneKey} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}
