import { useEffect, useRef } from 'react'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { botRefKey, botTarget } from '@/lib/bot-hosts'
import type { Bot } from '../../../../shared/bot-types'
import {
  nativeChatInstallSlotState,
  type NativeChatInstallSlotInstall
} from '../native-chat/host-access/NativeChatInstallSlot'
import { useStructuredAgentSessionHostProgram } from '../native-chat/session/status/structured-agent-session-status-hooks'

const CHANGING_PHASES: ReadonlySet<string> = new Set([
  'downloading',
  'extracting',
  'verifying',
  'removing'
])

// Bots whose card offered a step; outlives the card, which unmounts when its tab is left mid-download.
const offered = new Set<string>()

/** What a bot whose setup failed still needs on its computer: its agent installed. `retry` runs
 *  once an install the card offered is done, so setup carries on without another click. */
export function useBotSetupInstall(
  bot: Bot,
  shown: boolean,
  retry: () => void
): { install: NativeChatInstallSlotInstall | null } {
  const target = botTarget(bot)
  const hostProgram = useStructuredAgentSessionHostProgram(bot.chatSessionId ?? '', target)
  // A bot on the host program follows it too: Orca's copy of agy may be what it needs installed.
  const observation = useManagedRuntimeInstall(target, bot.agent, shown)
  const slot = nativeChatInstallSlotState(observation, 'strip', hostProgram)
  const install = shown && slot.kind === 'install' ? slot : null
  const state =
    shown && observation.kind === 'active' && observation.snapshot.kind === 'known'
      ? observation.snapshot.state
      : null
  const installed = state !== null && state.source !== null
  // An update of Orca's copy is not settled yet, so nothing is ready meanwhile.
  const changing = state?.operation ? CHANGING_PHASES.has(state.operation.phase) : false
  const waiting = install !== null
  const ready = installed && !changing && !waiting
  const latestRetry = useRef(retry)
  useEffect(() => {
    latestRetry.current = retry
  }, [retry])
  const key = botRefKey(bot)
  useEffect(() => {
    if (waiting) {
      offered.add(key)
    } else if (ready && offered.delete(key)) {
      latestRetry.current()
    }
  }, [key, waiting, ready])
  return { install }
}
