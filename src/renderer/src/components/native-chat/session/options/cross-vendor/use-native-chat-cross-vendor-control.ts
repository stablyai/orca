import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatStructuredViewProps } from '../../../native-chat-view-types'
import type { NativeChatCrossVendorControl } from './native-chat-cross-vendor-context'
import {
  switchBotHomeChatToVendor,
  switchNativeChatToVendor
} from './native-chat-cross-vendor-switch'

/** Null where a chat cannot hand its conversation to another agent: a bot's other chats, or no
 *  workspace. A bot's Home Chat moves the bot itself to the picked agent. */
export function useNativeChatCrossVendorControl(input: {
  pane: Pick<NativeChatStructuredViewProps, 'tabId' | 'sessionId' | 'agent' | 'target'>
  worktreeId: string | null
  isWorking: boolean
  reportError: (text: string | null) => void
}): NativeChatCrossVendorControl | null {
  const { pane, worktreeId, isWorking, reportError } = input
  const bot = useBotForWorkspace(worktreeId)
  const botHome = bot !== null && bot.chatSessionId === pane.sessionId
  const t = useTranslate()
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
      const request = {
        target: pane.target,
        sourceSessionId: pane.sessionId,
        sourceAgent: pane.agent,
        agent,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {})
      }
      void (
        bot && botHome
          ? switchBotHomeChatToVendor({ ...request, bot })
          : switchNativeChatToVendor({ ...request, worktreeId, sourceTabId: pane.tabId })
      ).then((outcome) => {
        inFlight.current = false
        setSwitching(null)
        if (!outcome.ok) {
          // Said in the chat, beside the composer that still talks to the original agent.
          reportError(outcome.error)
        }
      })
    },
    [worktreeId, pane.target, pane.tabId, pane.sessionId, pane.agent, reportError, bot, botHome]
  )
  const available = Boolean(worktreeId) && (bot === null || botHome) && isTuiAgent(pane.agent)
  return useMemo(
    () =>
      available
        ? {
            currentAgent: pane.agent,
            botOnly: bot !== null,
            worktreeId,
            target: pane.target,
            blockedReason: isWorking
              ? t(
                  'components.native-chat.crossVendor.waitForTurn',
                  'Wait for the current reply to finish, or stop it, before switching agents.'
                )
              : null,
            switching,
            switchTo
          }
        : null,
    [available, pane.agent, worktreeId, pane.target, isWorking, switching, switchTo, t, bot]
  )
}
