/**
 * The notice a bridged pane shows while its older relay can't be reached.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay/.
 */
import type { PtyTransport } from '../pty-transport-types'

type Callbacks = Parameters<PtyTransport['connect']>[0]['callbacks']

const UNREACHABLE_MESSAGE =
  'This terminal is still running on the host under an older version of Orca. Reconnecting to it…'

export function createLegacyRelayUnreachableNotice(callbacks: () => Callbacks | null): {
  show: () => void
  clear: () => void
} {
  let showing = false
  return {
    show: () => {
      if (!showing) {
        showing = true
        callbacks()?.onError?.(UNREACHABLE_MESSAGE)
      }
    },
    clear: () => {
      if (showing) {
        showing = false
        callbacks()?.onErrorCleared?.(UNREACHABLE_MESSAGE)
      }
    }
  }
}
