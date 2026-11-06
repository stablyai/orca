import { PLUGIN_DECLARATIVE_MESSAGES } from '../plugin-declarative-message-names'
import { captureAtomValues } from './declarative-atoms'
import { readHostMessage } from './declarative-host-messages'
import type { OrcaBridge, OrcaDisposable } from './declarative-runtime-types'

/**
 * `orca plugin shot --act` changes the live panel; Orca asks this guest to remember its atoms
 * before acting (`ui.snapshot`) and to put them back after the capture (`ui.restore`). Only this
 * guest's atoms: what handlers did elsewhere (worker requests, storage writes) stays.
 */
export function actSnapshotSubscriptions(
  on: NonNullable<OrcaBridge['on']>,
  document: string
): OrcaDisposable[] {
  let restore: (() => void) | null = null
  const ours = (payload: unknown): boolean => readHostMessage(payload).document === document
  return [
    on(PLUGIN_DECLARATIVE_MESSAGES.snapshot, (payload) => {
      if (ours(payload)) {
        restore = captureAtomValues()
      }
    }),
    on(PLUGIN_DECLARATIVE_MESSAGES.restore, (payload) => {
      if (ours(payload) && restore) {
        const pending = restore
        restore = null
        pending()
      }
    })
  ]
}
