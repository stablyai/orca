import type React from 'react'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { readCloudAgentHold, releaseCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { CloudAgentSignInStrip } from './CloudAgentSignInStrip'
import { useCloudHeldStrip } from './use-cloud-held-strip'
import './cloud-chat-banner-slot.css'

const ABANDON_CHECK_MS = 1_000

function tabStillOpen(tabId: string): boolean {
  const byWorktree = useAppStore.getState().unifiedTabsByWorktree ?? {}
  return Object.values(byWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

/**
 * CHAT-BANNERS (PR-B): a structured chat's cloud strip, at the top of its column under the header,
 * the same strip a terminal pane shows: "Set up once" or Renew while its launch is held.
 */
export function CloudStructuredChatBanners({
  tabId,
  paneKey
}: {
  tabId: string
  paneKey: string
}): React.JSX.Element {
  const { key, active, strip } = useCloudHeldStrip(paneKey, null)
  useEffect(() => {
    if (!active) {
      return
    }
    // A remount unmounts this too; only a chat that was closed gives up its held launch.
    return () => {
      setTimeout(() => {
        if (!tabStillOpen(tabId) && readCloudAgentHold(key)) {
          releaseCloudAgentHold(key, 'cancel')
        }
      }, ABANDON_CHECK_MS)
    }
  }, [active, key, tabId])
  return (
    <div data-cloud-chat-banners="" className="shrink-0">
      {strip ? <CloudAgentSignInStrip {...strip} width="wide" /> : null}
    </div>
  )
}
