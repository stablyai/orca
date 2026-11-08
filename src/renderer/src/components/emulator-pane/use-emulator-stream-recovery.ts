import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { EmulatorPaneSession } from './emulator-pane-types'

/** Retry native streams only when main requests fallback, once per identity, through normal attach ownership. */
export function useEmulatorRecovery(
  liveTargetRef: RefObject<string | null>,
  session: EmulatorPaneSession | null,
  setSession: Dispatch<SetStateAction<EmulatorPaneSession | null>>,
  streamKey: string | null,
  attach: (target: string) => Promise<void>
) {
  const fallbackStreamRef = useRef<string | null>(null)
  return useCallback(
    (retryWithScrcpy = false) => {
      const target = liveTargetRef.current
      liveTargetRef.current = null
      setSession((current) => (current?.attached ? { ...current, attached: false } : current))
      if (
        retryWithScrcpy &&
        target &&
        session?.info?.streamUrl?.startsWith('android-grpc://') &&
        fallbackStreamRef.current !== streamKey
      ) {
        fallbackStreamRef.current = streamKey
        void attach(target)
      }
    },
    [attach, liveTargetRef, session, setSession, streamKey]
  )
}
