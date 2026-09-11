// Whether a structured chat owned by a paired host may be written to from this client.
//
// The reader advertisement made a paired chat visible; this is the switch that makes it live, and
// it is off until the user turns it on. Off, a paired chat is a transcript: no send, no approval,
// no option change, and above all no hold. The hold is the one read-shaped call that is not a read
// — it opens the durable record on the other machine and hands its session a provider child back —
// so a pane that took one would start work on a host nobody is watching.
//
// Turning it back off never strands a session that already exists: the hold is withdrawn (which
// releases it) and close, cancel, unsubscribe and release keep their own path, matching the host
// gate, which admits cleanup on the negotiated capability alone rather than on admission.

import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '@/store'

export function structuredRemoteSessionWritesEnabled(
  settings: Pick<GlobalSettings, 'structuredChatRemoteCreate'> | null | undefined
): boolean {
  return settings?.structuredChatRemoteCreate === true
}

/** Subscribed, not read once: flipping the switch off has to reach an open pane and drop its hold. */
export function useStructuredRemoteSessionWritesEnabled(): boolean {
  return useAppStore((state) => structuredRemoteSessionWritesEnabled(state.settings))
}
