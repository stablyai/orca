import { useEffect, useMemo, useState } from 'react'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { deriveNativeChatCanSend } from './native-chat-send-eligibility'

/**
 * Track the mobile presence-lock for this chat pane's live pty and derive the
 * composer's `canSend` (R8). The driver Map lives outside React for perf, so we
 * subscribe to its change events and re-read on each flip. A pty held by a
 * mobile client guards desktop sends exactly as it guards xterm input.
 */
export function useNativeChatCanSend(ptyId: string | null): boolean {
  const [driverTick, setDriverTick] = useState(0)
  // Why: the driver event fires for every pty; only re-derive when it targets
  // this pane's pty. ptyId is a dep so the listener re-binds on a pty swap.
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
