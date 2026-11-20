import { useEffect, useRef } from 'react'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { botTarget } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  nativeChatInstallSlotState,
  type NativeChatInstallSlotInstall
} from '../native-chat/host-access/NativeChatInstallSlot'
import { useStructuredAgentSessionHostProgram } from '../native-chat/session/status/structured-agent-session-status-hooks'

// Bots whose card offered Install; outlives the card, which unmounts when its tab is left mid-download.
const offered = new Set<string>()

/** The chat's own Install for a bot whose setup failed on a computer without its agent.
 *  `retry` runs once the install it offered has landed, so setup carries on without another click. */
export function useBotSetupInstall(
  bot: Bot,
  shown: boolean,
  retry: () => void
): NativeChatInstallSlotInstall | null {
  const target = botTarget(bot)
  const hostProgram = useStructuredAgentSessionHostProgram(bot.chatSessionId ?? '', target)
  const observation = useManagedRuntimeInstall(target, bot.agent, shown && !hostProgram)
  const slot = nativeChatInstallSlotState(observation, 'strip', hostProgram)
  const install = shown && slot.kind === 'install' ? slot : null
  const installed =
    shown &&
    observation.kind === 'active' &&
    observation.snapshot.kind === 'known' &&
    observation.snapshot.state.source !== null
  const latestRetry = useRef(retry)
  useEffect(() => {
    latestRetry.current = retry
  }, [retry])
  const botId = bot.id
  useEffect(() => {
    if (install) {
      offered.add(botId)
    } else if (installed && offered.delete(botId)) {
      latestRetry.current()
    }
  }, [botId, install, installed])
  return install
}
