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
  kept: { current: ClearHold | null },
  hold: ClearHold,
  viewTab: NativeChatViewTab
): void {
  keptClearHoldRelease.get(kept)?.()
  keptClearHoldRelease.set(
    kept,
    onNativeChatViewTabRelease(viewTab, () => {
      if (kept.current === hold) {
        kept.current = null
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
  const kept = useNativeChatViewRef<ClearHold | null>('clear-hold', null)
  useNativeChatPaneLifetimeEffect(
    useCallback(() => {
      shown.current = sessionId
      // A remount of the same session takes its hold back; a view of another session ends it.
      keptClearHoldRelease.get(kept)?.()
      keptClearHoldRelease.delete(kept)
      if (kept.current && kept.current.sessionId !== sessionId) {
        kept.current.release()
        kept.current = null
      }
      return () => {
        shown.current = null
        const hold = kept.current
        if (hold && viewTab) {
          keepClearHoldPastView(kept, hold, viewTab)
        } else if (hold) {
          kept.current = null
          hold.release()
        }
      }
    }, [sessionId, kept, viewTab])
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
      setTimeout(release, AGENT_SESSION_CONVERSATION_COMMAND_TIMEOUT_MS)
      let movedOn = false
      return await runWithFinally(
        async () => {
          const outcome = await send()
          movedOn = outcome.kind === 'done' && outcome.value.replacementSessionId !== undefined
          return outcome
        },
        () => {
          // Kept while this session's view is shown, or released with the tab still open; else it ends now.
          const released = shown.current === null && viewTab !== null
          if (!movedOn || (shown.current !== sessionId && !released)) {
            release()
            return
          }
          kept.current?.release()
          const hold = { sessionId, release }
          kept.current = hold
          if (released) {
            keepClearHoldPastView(kept, hold, viewTab)
          }
        }
      )
    },
    [sessionId, write, kept, viewTab]
  )
}
