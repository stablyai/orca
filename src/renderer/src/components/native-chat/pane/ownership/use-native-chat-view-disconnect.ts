import { useEffectEvent, useLayoutEffect } from 'react'

/** Activity disconnects layout effects on hide even when no hidden render commits. */
export function useNativeChatViewDisconnect(onDisconnect: () => void): void {
  const disconnect = useEffectEvent(onDisconnect)
  useLayoutEffect(() => () => disconnect(), [])
}
