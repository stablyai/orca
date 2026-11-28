import { useEffect, useRef } from 'react'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { botRefKey, botTarget } from '@/lib/bot-hosts'
import { useAntigravityChatSignIn } from '@/components/provider-accounts/use-antigravity-chat-sign-in'
import type { Bot } from '../../../../shared/bot-types'
import {
  nativeChatInstallSlotState,
  type NativeChatInstallSlotInstall
} from '../native-chat/host-access/NativeChatInstallSlot'
import {
  useAntigravityChatSignInStrip,
  type NativeChatSignInStripState
} from '../native-chat/host-access/NativeChatSignInStrip'

const CHANGING_PHASES: ReadonlySet<string> = new Set([
  'downloading',
  'extracting',
  'verifying',
  'removing'
])

// Bots whose card offered a step; outlives the card, which unmounts when its tab is left mid-download.
const offered = new Set<string>()

/** What a bot whose setup failed still needs on its computer: the agent Orca downloads for it, or
 *  agy's sign-in for an Antigravity bot on a Google method. `retry` runs once a step the card
 *  offered is done, so setup carries on without another click. */
export function useBotSetupInstall(
  bot: Bot,
  shown: boolean,
  retry: () => void
): { install: NativeChatInstallSlotInstall | null; signIn: NativeChatSignInStripState | null } {
  const target = botTarget(bot)
  const observation = useManagedRuntimeInstall(target, bot.agent, shown)
  const slot = nativeChatInstallSlotState(observation, 'strip')
  const install = shown && slot.kind === 'install' ? slot : null
  const state =
    shown && observation.kind === 'active' && observation.snapshot.kind === 'known'
      ? observation.snapshot.state
      : null
  // The user installs agy, so its sign-in is the one step an Antigravity bot's card offers; the
  // host reports agy signed out only where agy is installed. Same rule as the chat's own strip.
  const signsIn = bot.agent === 'antigravity'
  const installed = signsIn || (state !== null && state.source !== null)
  // An update isn't settled until it ends, so nothing is ready meanwhile.
  const changing = state?.operation ? CHANGING_PHASES.has(state.operation.phase) : false
  const signIn = useAntigravityChatSignInStrip(signsIn && shown ? target : null, bot.agent)
  const signInStatus = useAntigravityChatSignIn(signsIn && shown ? target : null).status
  const waiting = install !== null || signIn !== null
  // A sign-in the host has not reported yet could still be owed, so the retry waits for it.
  const ready = installed && !changing && !waiting && (!signsIn || signInStatus === 'known')
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
