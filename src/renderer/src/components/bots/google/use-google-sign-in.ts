import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  GoogleAccountView,
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

/** One Connect Google at a time from this surface: its state, and a cancel that stops it on the host
 *  (only while it's waiting) and clears it. */
export function useGoogleSignIn(
  target: RuntimeClientTarget,
  /** The bot it signs in for, so a server's page opens in that bot's workspace. */
  bot?: BotRef
): {
  state: GoogleSignInState
  connect: (
    services: readonly GoogleServiceChoice[],
    account?: string
  ) => Promise<GoogleAccountView | null>
  cancel: () => void
} {
  const [state, setState] = useState<GoogleSignInState>({ kind: 'idle' })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Whether the module's running sign-in is this hook's, so cancel never stops another surface's.
  const waiting = useRef(false)
  const show = (next: GoogleSignInState): void => {
    waiting.current = next.kind === 'waiting'
    if (mounted.current) {
      setState(next)
    }
  }
  // A cancelled run's rejection is what the person asked for, not a failure to show.
  const runs = useRef(0)
  const connect = useCallback(
    async (services: readonly GoogleServiceChoice[], account?: string) => {
      const run = ++runs.current
      show({ kind: 'waiting', prompt: null })
      try {
        const connected = await connectGoogle(
          target,
          { services, ...(account ? { account } : {}), ...(bot ? { bot } : {}) },
          (prompt, way) => show({ kind: 'waiting', prompt, way })
        )
        show({ kind: 'idle' })
        return connected
      } catch (error) {
        if (runs.current === run) {
          show({ kind: 'failed', error: error instanceof Error ? error.message : String(error) })
        }
        return null
      }
    },
    [target, bot]
  )
  const cancel = useCallback(() => {
    runs.current += 1
    if (waiting.current) {
      void cancelGoogleSignIn()
    }
    show({ kind: 'idle' })
  }, [])
  return { state, connect, cancel }
}
