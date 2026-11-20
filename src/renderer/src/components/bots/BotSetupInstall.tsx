import { useEffect, useRef } from 'react'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { botRefKey, botTarget } from '@/lib/bot-hosts'
import { useAntigravityChatSignIn } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import {
  antigravityChatSignInPrompt,
  antigravityOrcaRuntimeSignsIn
} from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import type { Bot } from '../../../../shared/bot-types'
import {
  nativeChatInstallSlotState,
  type NativeChatInstallSlotInstall
} from '../native-chat/host-access/NativeChatInstallSlot'
import type { NativeChatSignInStripState } from '../native-chat/host-access/NativeChatSignInStrip'
import { useStructuredAgentSessionHostProgram } from '../native-chat/session/status/structured-agent-session-status-hooks'

const CHANGING_PHASES: ReadonlySet<string> = new Set([
  'downloading',
  'extracting',
  'verifying',
  'removing'
])

// Bots whose card offered a step; outlives the card, which unmounts when its tab is left mid-download.
const offered = new Set<string>()

/** What a bot whose setup failed still needs on its computer: its agent installed, then Orca's
 *  sign-in where the agent has one. `retry` runs once a step the card offered is done, so setup
 *  carries on without another click. */
export function useBotSetupInstall(
  bot: Bot,
  shown: boolean,
  retry: () => void
): { install: NativeChatInstallSlotInstall | null; signIn: NativeChatSignInStripState | null } {
  const target = botTarget(bot)
  const hostProgram = useStructuredAgentSessionHostProgram(bot.chatSessionId ?? '', target)
  const observation = useManagedRuntimeInstall(target, bot.agent, shown && !hostProgram)
  const slot = nativeChatInstallSlotState(observation, 'strip', hostProgram)
  const install = shown && slot.kind === 'install' ? slot : null
  const state =
    shown && observation.kind === 'active' && observation.snapshot.kind === 'known'
      ? observation.snapshot.state
      : null
  const installed = state !== null && state.source !== null
  // An update of Orca's copy hides the sign-in without settling it, so nothing is ready meanwhile.
  const changing = state?.operation ? CHANGING_PHASES.has(state.operation.phase) : false
  // Same rule as the chat's own strip: only Orca's copy of Antigravity takes Orca's sign-in.
  const signsIn =
    bot.agent === 'antigravity' &&
    installed &&
    observation.kind === 'active' &&
    antigravityOrcaRuntimeSignsIn(observation)
  const signInView = useAntigravityChatSignIn(signsIn ? target : null)
  const prompt = signsIn ? antigravityChatSignInPrompt(signInView) : null
  const signIn =
    prompt === null ? null : { prompt, view: signInView, agent: bot.agent, host: target }
  const waiting = install !== null || prompt !== null
  // A sign-in the host has not reported yet could still be owed, so the retry waits for it.
  const ready = installed && !changing && !waiting && (!signsIn || signInView.status === 'known')
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
  return { install, signIn }
}
