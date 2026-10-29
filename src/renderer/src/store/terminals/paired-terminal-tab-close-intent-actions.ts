import { editSessionSource, type SessionSourceSet } from '@/store/session-source-edits'
import type { PairedTerminalTabCloseIntent } from '../../../../shared/paired-terminal-tab-close-intent'
import {
  clearPairedTerminalTabCloseIntents,
  recordPairedTerminalTabCloseIntent,
  type PairedTerminalTabCloseIntentsByEnvironment
} from '../../runtime/paired-terminal-tab-close-intents'

export type PairedTerminalTabCloseIntentSlice = {
  /** Persist unacknowledged paired-host closes by environment so reload/snapshots cannot reopen closed tabs. */
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
  set: SessionSourceSet<PairedTerminalTabCloseIntentFields>
): PairedTerminalTabCloseIntentSlice {
  return {
    pairedTerminalTabCloseIntentsByEnvironment: {},
    recordPairedTerminalTabCloseIntent: (environmentId, intent) => {
      set((s) => {
        const edit = editSessionSource(s)
        const changed = recordPairedTerminalTabCloseIntent(edit, environmentId, intent)
        return changed ? edit.finish() : undefined
      })
    },
    clearPairedTerminalTabCloseIntents: (environmentId, intentKeys) => {
      set((s) => {
        const edit = editSessionSource(s)
        const changed = clearPairedTerminalTabCloseIntents(edit, {
          environmentId,
          intentKeys,
          now: Date.now()
        })
        return changed ? edit.finish() : undefined
      })
    }
  }
}
