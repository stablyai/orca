import { runtimeHostContactFromSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-contact'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import '../../../../../shared/runtime-workspace-window-availability'

import {
  type RuntimeHostConnectionState,
  runtimeHostConnectionState
} from '../../../../../shared/remote-runtime/host-status/runtime-host-connection-state'

/**
 * Only this verdict earns the destructive glyph. 'checking' and 'reconnecting' are
 * unverifiable, not down, per docs/reference/ssh-execution-boundary.md.
 */
export function isDisconnectedRuntimeHostState(state: RuntimeHostConnectionState): boolean {
  return state === 'disconnected'
}

/** The same derivation, read straight off a recorded status entry. */
export function runtimeHostConnectionStateForEntry(
  entry:
    | {
        status: RuntimeStatus | null
        remoteControl?: RuntimeStatus['remoteControl'] | null
        snapshot?: RuntimeHostStatusSnapshot
      }
    | null
    | undefined
): RuntimeHostConnectionState {
  const snapshot = entry?.snapshot
  if (snapshot) {
    // Name nonverified contact outcomes once so readers choose an arm instead of guessing from null snapshot fields.
    const contact = runtimeHostContactFromSnapshot(snapshot, entry?.status ?? null)
    if (contact.verdict === 'retired' || contact.verdict === 'refused') {
      return 'disconnected'
    }
    if (contact.verdict === 'unverifiable') {
      if (contact.reason === 'transport-down') {
        return 'reconnecting'
      }
      if (contact.reason === 'checking') {
        return 'checking'
      }
      if (contact.reason === 'probe-failed') {
        return 'runtime-unavailable'
      }
    }
  }
  return runtimeHostConnectionState({
    hasStatusEntry: Boolean(entry),
    status: entry?.status ?? null,
    // Connecting is ongoing negotiation; unknown is never attempted and may remain so permanently. Calling unknown checking hides Connect and pins the spinner forever.
    ...(snapshot?.transport === 'connecting' ? { transportStatus: 'checking' as const } : {}),
    remoteControl: entry?.remoteControl ?? entry?.status?.remoteControl ?? null
  })
}
