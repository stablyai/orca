import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import { getDriverForPty, onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import {
  deriveNativeChatCanSend,
  isNativeChatAgentForegroundGone
} from './native-chat-send-eligibility'

/** Why a lockedReason and not just the boolean: the composer's placeholder needs to tell
 *  "another device has it" apart from "the agent isn't running" — very different next
 *  actions for the user. `null` when unlocked. */
export type NativeChatSendLock = 'mobile' | 'agent-gone' | null

export type NativeChatSendEligibility = {
  canSend: boolean
  lockedReason: NativeChatSendLock
}

/**
 * Track the mobile presence-lock and the pane's own foreground-agent evidence for this chat
 * pane's live pty, and derive the composer's `canSend`. The driver Map lives outside React
 * for perf, so we subscribe to its change events and re-read on each flip. Mobile lock is
 * checked first since it is the more specific/user-actionable reason ("another device has
 * it" vs. "nothing is running").
 */
export function useNativeChatCanSend(
  ptyId: string | null,
  paneKey: string
): NativeChatSendEligibility {
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
  const shellForeground = useAppStore(
    (s) => s.paneForegroundAgentByPaneKey[paneKey]?.shellForeground ?? false
  )
  return useMemo<NativeChatSendEligibility>(() => {
    void driverTick
    if (!deriveNativeChatCanSend(ptyId ? getDriverForPty(ptyId) : null)) {
      return { canSend: false, lockedReason: 'mobile' }
    }
    const isRemote = ptyId !== null && isRemoteRuntimePtyId(ptyId)
    if (isNativeChatAgentForegroundGone({ shellForeground, isRemote })) {
      return { canSend: false, lockedReason: 'agent-gone' }
    }
    return { canSend: true, lockedReason: null }
  }, [ptyId, driverTick, shellForeground])
}
