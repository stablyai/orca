import { useCallback } from 'react'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewGuard,
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
  | {
      kind: 'waiting'
      prompt: GoogleSignInPrompt | null
      way?: GoogleSignInWay
      /** Kept-state marker: a waiting sign-in is never dropped to make room. */
      inFlight?: true
    }
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
  // Kept with the chat tab, newest few runs: a sign-in still waiting stays shown through the chat's release and is
  // never the one dropped; a finished one returns to idle, which keeps nothing.
  const [state, setState] = useNativeChatViewState<GoogleSignInState>(
    memoryKey === undefined ? undefined : `google-sign-in:${memoryKey}`,
    IDLE,
    KEPT_PROMPT_VIEWS
  )
  // The run this hook started, so cancel never stops another surface's, and a cancelled run's rejection isn't
  // shown. Cleared when the run ends, so a settled card keeps nothing.
  const [, setRun, readRun] = useNativeChatViewGuard<symbol | null>(
    memoryKey === undefined ? undefined : `google-sign-in-run:${memoryKey}`,
    null
  )
  const connect = useCallback(
    async (
      services: readonly GoogleServiceChoice[],
      account?: string,
      options?: Pick<GoogleSignInAsk, 'currentApp'>
    ) => {
      // One run per surface: a same-frame second press would orphan the first.
      if (readRun() !== null) {
        return null
      }
      const run = Symbol('google-sign-in')
      setRun(run)
      setState({ kind: 'waiting', prompt: null, inFlight: true })
      try {
        const connected = await connectGoogle(
          target,
          {
            services,
            ...(account ? { account } : {}),
            ...(options?.currentApp ? { currentApp: true } : {}),
            ...(bot ? { bot } : {})
          },
          (prompt, way) => {
            if (readRun() === run) {
              setState({ kind: 'waiting', prompt, way, inFlight: true })
            }
          }
        )
        if (readRun() !== run) {
          // Cancelled meanwhile: what it signed in isn't this card's to act on.
          return null
        }
        setRun(null)
        setState(IDLE)
        return connected
      } catch (error) {
        if (readRun() === run) {
          setRun(null)
          setState({
            kind: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
        return null
      }
    },
    [target, bot, readRun, setRun, setState]
  )
  const cancel = useCallback(() => {
    if (readRun() !== null) {
      setRun(null)
      void cancelGoogleSignIn()
    }
    setState(IDLE)
  }, [readRun, setRun, setState])
  return { state, connect, cancel }
}
