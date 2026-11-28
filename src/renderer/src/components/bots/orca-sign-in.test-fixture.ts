// This window's Orca account, signed in or out, for tests and screenshots of what waits on sign-in.
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'
import type { NativeChatBotKickoffView } from '../native-chat/native-chat-bot-kickoff-view'

export const ORCA_CONNECTED: OrcaProfileAuthStatus = {
  activeProfileId: 'p1',
  configured: true,
  state: 'connected',
  persistence: 'encrypted'
}
export const ORCA_SIGNED_OUT: OrcaProfileAuthStatus = { ...ORCA_CONNECTED, state: 'local' }

/** Sign in as the browser would finish it: `before` runs, then the window is signed in. */
export function orcaSignIn(before?: () => unknown): AppState['connectCurrentOrcaProfile'] {
  return async () => {
    await before?.()
    useAppStore.setState({ orcaProfileAuthStatus: ORCA_CONNECTED })
    return { status: 'connected', auth: ORCA_CONNECTED, activeProfileId: 'p1', profiles: [] }
  }
}

/** A bot chat that takes every send. */
export function chatTakingSends(
  send: (text: string) => Promise<boolean>
): NativeChatBotKickoffView {
  return {
    live: false,
    send,
    sendBlockedReason: () => undefined,
    bot: null,
    sessionId: 'chat-1',
    firstScreen: null,
    firstKickoffId: null
  }
}
