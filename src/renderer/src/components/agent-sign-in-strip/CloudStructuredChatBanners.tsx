import type React from 'react'
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { readCloudAgentHold, releaseCloudAgentHold } from '@/lib/orca-cloud/cloud-agent-launch-hold'
import { CloudAgentSignInStrip } from './CloudAgentSignInStrip'
import { useCloudHeldStrip } from './use-cloud-held-strip'
import { useCloudChatRunningStrip } from './use-cloud-chat-running-strip'
import './cloud-chat-banner-slot.css'

const ABANDON_CHECK_MS = 1_000

function tabStillOpen(tabId: string): boolean {
  const byWorktree = useAppStore.getState().unifiedTabsByWorktree ?? {}
  return Object.values(byWorktree).some((tabs) => tabs?.some((tab) => tab.id === tabId))
}

/**
 * CHAT-BANNERS (PR-B): a structured chat's cloud strip, at the top of its column under the header,
 * the same strips a terminal pane shows: "Set up once" or Renew while its launch is held, and
 * RA-11's "sign-in expired · Renew" while its agent runs (B2).
 */
export function CloudStructuredChatBanners({
  tabId,
  paneKey,
  statusKey
}: {
  tabId: string
  /** The launch-hold key (from the session id). */
  paneKey: string
  /** The agent-status key (tab and session): the running strip (B2) reads the agent through it. */
  statusKey: string
}): React.JSX.Element {
  const { key, active, strip } = useCloudHeldStrip(paneKey, null, { chat: true })
  const running = useCloudChatRunningStrip({ tabId, statusKey, holdKey: paneKey })
  const shown = strip ?? running
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
      {shown ? <CloudAgentSignInStrip {...shown} width="wide" /> : null}
    </div>
  )
}
