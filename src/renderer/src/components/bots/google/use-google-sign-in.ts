import { useCallback } from 'react'
import {
  useNativeChatViewRef,
  useNativeChatViewState
} from '../../native-chat/pane/ownership/native-chat-view-memory'
import type {
  GoogleAccountView,
  GoogleSignInAsk,
  GoogleSignInPrompt
} from '../../../../../shared/google/google-connect-types'
import type { GoogleServiceChoice } from '../../../../../shared/google/google-scopes'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotRef } from '@/lib/bot-hosts'
import { cancelGoogleSignIn, connectGoogle, type GoogleSignInWay } from './google-connect-client'

export type GoogleSignInState =
  | { kind: 'idle' }
  /** `prompt` arrives once the host has the Google link, with where it opened; Open again reopens it. */
  | { kind: 'waiting'; prompt: GoogleSignInPrompt | null; way?: GoogleSignInWay }
  | { kind: 'failed'; error: string }

const IDLE: GoogleSignInState = { kind: 'idle' }

/** One Connect Google at a time from this surface: its state, and a cancel that stops it on the host
 *  (only while it's waiting) and clears it. */
export function useGoogleSignIn(
  target: RuntimeClientTarget,
  /** The bot it signs in for, so a server's page opens in that bot's workspace. */
  bot?: BotRef,
  /** A card in a chat: a sign-in still waiting stays shown, and cancellable, through the chat's release. */
  memoryKey?: string
): {
  state: GoogleSignInState
  connect: (
    services: readonly GoogleServiceChoice[],
    account?: string,
    options?: Pick<GoogleSignInAsk, 'currentApp'>
  ) => Promise<GoogleAccountView | null>
  cancel: () => void
} {
  const [state, setState] = useNativeChatViewState<GoogleSignInState>(
    memoryKey === undefined ? undefined : `google-sign-in:${memoryKey}`,
    IDLE
  )
  // Whether the module's running sign-in is this hook's, so cancel never stops another surface's; and the run
  // count, so a cancelled run's rejection isn't shown. Kept with the chat tab like the state.
  const own = useNativeChatViewRef(
    memoryKey === undefined ? undefined : `google-sign-in-run:${memoryKey}`,
    { waiting: false, runs: 0 }
  )
  const show = useCallback(
    (next: GoogleSignInState): void => {
      own.current.waiting = next.kind === 'waiting'
      setState(next)
    },
    [own, setState]
  )
  const connect = useCallback(
    async (
      services: readonly GoogleServiceChoice[],
      account?: string,
      options?: Pick<GoogleSignInAsk, 'currentApp'>
    ) => {
      const run = ++own.current.runs
      show({ kind: 'waiting', prompt: null })
      try {
        const connected = await connectGoogle(
          target,
          {
            services,
            ...(account ? { account } : {}),
            ...(options?.currentApp ? { currentApp: true } : {}),
            ...(bot ? { bot } : {})
          },
          (prompt, way) => show({ kind: 'waiting', prompt, way })
        )
        show({ kind: 'idle' })
        return connected
      } catch (error) {
        if (own.current.runs === run) {
          show({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
        return null
      }
    },
    [target, bot, own, show]
  )
  const cancel = useCallback(() => {
    own.current.runs += 1
    if (own.current.waiting) {
      void cancelGoogleSignIn()
    }
    show(IDLE)
  }, [own, show])
  return { state, connect, cancel }
}
