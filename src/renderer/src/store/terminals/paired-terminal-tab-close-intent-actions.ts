import type { PairedTerminalTabCloseIntent } from '../../../../shared/paired-terminal-tab-close-intent'
import {
  clearPairedTerminalTabCloseIntents,
  recordPairedTerminalTabCloseIntent,
  type PairedTerminalTabCloseIntentsByEnvironment
} from '../../runtime/paired-terminal-tab-close-intents'

export type PairedTerminalTabCloseIntentSlice = {
  /**
   * User closes of a paired host's tabs that never reached it, keyed by runtime environment.
   * Persisted so a reload cannot let the host's next snapshot bring the closed tab back.
   */
  pairedTerminalTabCloseIntentsByEnvironment: PairedTerminalTabCloseIntentsByEnvironment
  recordPairedTerminalTabCloseIntent: (
    environmentId: string,
    intent: PairedTerminalTabCloseIntent
  ) => void
  clearPairedTerminalTabCloseIntents: (environmentId: string, intentKeys: readonly string[]) => void
}

type PairedTerminalTabCloseIntentFields = Pick<
  PairedTerminalTabCloseIntentSlice,
  'pairedTerminalTabCloseIntentsByEnvironment'
>

/** Returning the state unchanged is a no-op: no new object, so no session write. */
export function createPairedTerminalTabCloseIntentSlice(
  set: (
    update: (s: PairedTerminalTabCloseIntentFields) => Partial<PairedTerminalTabCloseIntentFields>
  ) => void
): PairedTerminalTabCloseIntentSlice {
  return {
    pairedTerminalTabCloseIntentsByEnvironment: {},
    recordPairedTerminalTabCloseIntent: (environmentId, intent) => {
      set((s) => {
        const next = recordPairedTerminalTabCloseIntent(
          s.pairedTerminalTabCloseIntentsByEnvironment,
          environmentId,
          intent
        )
        return next ? { pairedTerminalTabCloseIntentsByEnvironment: next } : s
      })
    },
    clearPairedTerminalTabCloseIntents: (environmentId, intentKeys) => {
      set((s) => {
        const next = clearPairedTerminalTabCloseIntents(
          s.pairedTerminalTabCloseIntentsByEnvironment,
          { environmentId, intentKeys, now: Date.now() }
        )
        return next ? { pairedTerminalTabCloseIntentsByEnvironment: next } : s
      })
    }
  }
}
