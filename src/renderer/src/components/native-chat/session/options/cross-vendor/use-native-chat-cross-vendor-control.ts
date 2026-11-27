import { useCallback, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatStructuredViewProps } from '../../../native-chat-view-types'
import type { NativeChatCrossVendorControl } from './native-chat-cross-vendor-context'
import { switchNativeChatToVendor } from './native-chat-cross-vendor-switch'

/** Null where a chat cannot hand its conversation to another agent: a bot's chat, or no workspace. */
export function useNativeChatCrossVendorControl(input: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'agent' | 'target'>
  worktreeId: string | null
  isWorking: boolean
  reportError: (text: string | null) => void
}): NativeChatCrossVendorControl | null {
  const { pane, worktreeId, isWorking, reportError } = input
  // A bot's chats keep the bot's own agent.
  const isBotChat = useBotForWorkspace(worktreeId) !== null
  const [switching, setSwitching] = useState<TuiAgent | null>(null)
  const inFlight = useRef(false)
  const switchTo = useCallback(
    (agent: TuiAgent, model?: string, effort?: string) => {
      if (!worktreeId || inFlight.current) {
        return
      }
      inFlight.current = true
      setSwitching(agent)
      reportError(null)
      void switchNativeChatToVendor({
        worktreeId,
        target: pane.target,
        sourceTabId: pane.tabId,
        sourceSessionId: pane.sessionId,
        sourceAgent: pane.agent,
        agent,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      }).then((outcome) => {
        inFlight.current = false
        setSwitching(null)
        if (!outcome.ok) {
          // Said in the chat, beside the composer that still talks to the original agent.
          reportError(outcome.error)
        }
      })
    },
    [worktreeId, pane.target, pane.tabId, pane.sessionId, pane.agent, reportError]
  )
  const available = Boolean(worktreeId) && !isBotChat && isTuiAgent(pane.agent)
  return useMemo(
    () =>
      available
        ? {
            currentAgent: pane.agent,
            worktreeId,
            target: pane.target,
            blockedReason: isWorking
              ? translate(
                  'components.native-chat.crossVendor.waitForTurn',
                  'Wait for the current reply to finish, or stop it, before switching agents.'
                )
              : null,
            switching,
            switchTo
          }
        : null,
    [available, pane.agent, worktreeId, pane.target, isWorking, switching, switchTo]
  )
}
