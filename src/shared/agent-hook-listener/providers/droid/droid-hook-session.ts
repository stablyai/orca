import type { ProviderHookSession } from '../../provider-hook-session'
import { normalizeDroidEvent } from './droid-events'
import {
  admitDroidHook,
  droidExitMarker,
  droidRowProviderSession,
  restatedDroidEvent
} from './droid-sessions'
import { readDroidTranscriptCallingSessionId } from './droid-transcript-origin'

export const DROID_HOOK_SESSION_PROVIDER: ProviderHookSession = {
  retainPaneRoot: true,
  exitMarker: droidExitMarker,
  admit({ state, paneKey, eventName, hookPayload, promptText, sender, previous, base }) {
    const admission = admitDroidHook(state, paneKey, eventName, hookPayload, sender, previous)
    if (admission.kind === 'skip' || admission.kind === 'restate') {
      return {
        kind: 'handled',
        event: restatedDroidEvent(previous, admission, base)
      }
    }
    return {
      kind: 'normalize',
      normalization: {
        normalize: () =>
          normalizeDroidEvent(state, eventName, promptText, paneKey, hookPayload, admission),
        providerSession: droidRowProviderSession(admission, base.providerSession ?? null, previous),
        suppressPrompt: admission.kind === 'child'
      }
    }
  },
  readPaneSession({ state, paneKey, hookPayload, session }) {
    const previous = state.lastStatusByPaneKey.get(paneKey)
    const owner = previous?.payload.agentType === 'droid' ? previous.providerSession : undefined
    return owner?.id !== session.id && readDroidTranscriptCallingSessionId(hookPayload)
      ? (owner ?? null)
      : session
  }
}
