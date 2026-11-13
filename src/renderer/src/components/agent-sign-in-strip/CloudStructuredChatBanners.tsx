import type React from 'react'
import { useEffect, useRef } from 'react'
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
  statusKey,
  agent
}: {
  tabId: string
  /** The launch-hold key (from the session id). */
  paneKey: string
  /** The agent-status key (tab and session): the running strip (B2) reads the agent through it. */
  statusKey: string
  /** The chat's agent, for an idle chat with no status yet. */
  agent?: string
}): React.JSX.Element {
  const { key, active, strip } = useCloudHeldStrip(paneKey, null, { chat: true })
  const running = useCloudChatRunningStrip({ tabId, statusKey, holdKey: paneKey, agent })
  const shown = strip ?? running
  const slot = useRef<HTMLDivElement>(null)
  // END-PASS CHAT-RENEW: Escape anywhere in this chat (focus is usually in the composer, which spends
  // Escape on interrupting a turn) stops a sign-in or renewal that is mid-flow and goes back to step 1,
  // as the strip's × does. The composer leaves an Escape another layer already took.
  const midFlow =
    shown !== null &&
    !shown.model.noClose &&
    (shown.model.paste !== null ||
      shown.model.code !== null ||
      shown.model.primary?.action.kind === 'reopenSetup' ||
      (shown.model.status === 'busy' && shown.model.primary === null))
  const cancel = shown?.actions.cancel
  useEffect(() => {
    if (!midFlow || !cancel) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const chat = slot.current?.closest('[data-native-chat-root]') ?? slot.current?.parentElement
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !chat?.contains(event.target)
      ) {
        return
      }
      event.preventDefault()
      cancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [midFlow, cancel])
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
    <div ref={slot} data-cloud-chat-banners="" className="shrink-0">
      {shown ? <CloudAgentSignInStrip {...shown} width="wide" /> : null}
    </div>
  )
}
