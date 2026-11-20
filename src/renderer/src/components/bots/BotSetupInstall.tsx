import { useEffect, useRef } from 'react'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { botTarget } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  nativeChatInstallSlotState,
  type NativeChatInstallSlotInstall
} from '../native-chat/host-access/NativeChatInstallSlot'
import { useStructuredAgentSessionHostProgram } from '../native-chat/session/status/structured-agent-session-status-hooks'

/** The chat's own Install for a bot whose setup failed on a computer without its agent.
 *  `retry` runs once the install it offered has landed, so setup carries on without another click. */
export function useBotSetupInstall(
  bot: Bot,
  failed: boolean,
  retry: () => void
): NativeChatInstallSlotInstall | null {
  const target = botTarget(bot)
  const hostProgram = useStructuredAgentSessionHostProgram(bot.chatSessionId ?? '', target)
  const observation = useManagedRuntimeInstall(target, bot.agent, failed)
  const slot = nativeChatInstallSlotState(observation, 'strip', hostProgram)
  const install = failed && slot.kind === 'install' ? slot : null
  const installed =
    observation.kind === 'active' &&
    observation.snapshot.kind === 'known' &&
    observation.snapshot.state.source !== null
  const offered = useRef(false)
  const latestRetry = useRef(retry)
  useEffect(() => {
    latestRetry.current = retry
  }, [retry])
  useEffect(() => {
    if (install) {
      offered.current = true
    } else if (offered.current && installed) {
      offered.current = false
      latestRetry.current()
    }
  }, [install, installed])
  return install
}
