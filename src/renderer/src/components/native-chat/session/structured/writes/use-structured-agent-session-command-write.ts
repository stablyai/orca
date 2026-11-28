import { runWithFinally } from '@/lib/run-with-finally'
import { useNativeChatPaneLifetimeEffect } from '../../../pane/ownership/native-chat-pane-lifetime'
import { useCallback, useContext, useRef } from 'react'
import {
  NativeChatViewTabContext,
  onNativeChatViewTabRelease,
  useNativeChatViewRef,
  type NativeChatViewTab
} from '../../../pane/ownership/native-chat-view-memory'
import {
  AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS,
  agentSessionConversationCommandFields,
  type AgentSessionConversationCommand,
  type AgentSessionConversationCommandResult
} from '../../../../../../../shared/agent-session/conversation-context/agent-session-conversation-command'
import type {
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'
import { holdStructuredAgentSessionSends } from '../delivery/structured-agent-session-pending-sends'

type ClearHold = { sessionId: string; release: () => void }
// The tab-close release of a hold whose view was released, by the kept hold ref it belongs to.
const keptClearHoldRelease = new WeakMap<object, () => void>()

/** A hold outliving its view ends when the tab closes, the page goes, or a view of another session mounts. */
function keepClearHoldPastView(
  keptRef: { current: ClearHold | null },
  hold: ClearHold,
  viewTab: NativeChatViewTab
): void {
  keptClearHoldRelease.get(keptRef)?.()
  keptClearHoldRelease.set(
    keptRef,
    onNativeChatViewTabRelease(viewTab, () => {
      if (keptRef.current === hold) {
        keptRef.current = null
      }
      hold.release()
    })
  )
}

/**
 * Holds sends during clear; an older host's replacement keeps the hold until the tab shows the new session. The
 * hold is kept with the chat tab, so a view released meanwhile returns still holding, and a clear that settles
 * after the release still keeps it.
 */
export function useStructuredAgentSessionCommandWrite(
  sessionId: string,
  write: StructuredAgentSessionWrite
): (
  command: AgentSessionConversationCommand,
  delivery?: 'queue-if-active',
  instructions?: string
) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>> {
  const viewTab = useContext(NativeChatViewTabContext)
  // Null once the view goes, so a reply that lands later knows no view of it is shown.
  const shown = useRef<string | null>(sessionId)
  const keptRef = useNativeChatViewRef<ClearHold | null>('clear-hold', null)
  // The session the tab's mounted view shows, if any: a reply landing after release keeps its hold only when no
  // view of another session holds the tab.
  const shownInTabRef = useNativeChatViewRef<string | null>('clear-shown-session', null)
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      shown.current = sessionId
      shownInTabRef.current = sessionId
      // A remount of the same session takes its hold back; a view of another session ends it.
      keptClearHoldRelease.get(keptRef)?.()
      keptClearHoldRelease.delete(keptRef)
      if (keptRef.current && keptRef.current.sessionId !== sessionId) {
        keptRef.current.release()
        keptRef.current = null
      }
      return () => {
        shown.current = null
        if (shownInTabRef.current === sessionId) {
          shownInTabRef.current = null
        }
        const hold = keptRef.current
        if (hold && viewTab) {
          keepClearHoldPastView(keptRef, hold, viewTab)
        } else if (hold) {
          keptRef.current = null
          hold.release()
        }
      }
    }, [sessionId, keptRef, shownInTabRef, viewTab])
  )
  return useCallback(
    async (command, delivery, instructions) => {
      const send = () =>
        write<AgentSessionConversationCommandResult>(
          'agentSession.conversationCommand',
          'agentSession.conversationCommand',
          agentSessionConversationCommandFields(command, { instructions, delivery })
        )
      if (command !== 'clear') {
        return send()
      }
      const release = holdStructuredAgentSessionSends(sessionId)
      setTimeout(() => {
        release()
        // A spent hold leaves nothing for later unmounts to carry.
        if (keptRef.current?.release === release) {
          keptRef.current = null
        }
      }, AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS)
      let movedOn = false
      return await runWithFinally(
        async () => {
          const outcome = await send()
          movedOn = outcome.kind === 'done' && outcome.value.replacementSessionId !== undefined
          return outcome
        },
        () => {
          // Kept while a view of this session is shown (this one or its remount), or released with the tab still
          // open; else it ends now.
          const stillShown = shown.current === sessionId || shownInTabRef.current === sessionId
          const released =
            shown.current === null && viewTab !== null && shownInTabRef.current === null
          if (!movedOn || (!stillShown && !released)) {
            release()
            return
          }
          if (keptRef.current?.sessionId === sessionId) {
            keptRef.current.release()
          }
          const hold = { sessionId, release }
          keptRef.current = hold
          if (released) {
            keepClearHoldPastView(keptRef, hold, viewTab)
          }
        }
      )
    },
    [sessionId, write, keptRef, shownInTabRef, viewTab]
  )
}
