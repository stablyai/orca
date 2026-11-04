import { useEffect, useMemo, useState } from 'react'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from './native-chat-send-eligibility'

/** Subscribe to the external driver map so mobile-owned PTYs guard composer sends just like xterm input. */
export function useNativeChatCanSend(ptyId: string | null): boolean {
  const [driverTick, setDriverTick] = useState(0)
  // Filter per-PTY driver events and rebind when pane ownership changes.
  useEffect(
    () =>
      onDriverChange((event) => {
        if (event.ptyId !== ptyId) {
          return
        }
        setDriverTick((n) => n + 1)
      }),
    [ptyId]
  )
  return useMemo(() => {
    void driverTick
    return deriveNativeChatCanSend(ptyId ? getDriverForPty(ptyId) : null)
  }, [ptyId, driverTick])
}
