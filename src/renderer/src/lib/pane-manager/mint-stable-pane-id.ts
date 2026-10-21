import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { createBrowserUuid } from '../browser-uuid'

export function mintStablePaneId(): TerminalLeafId {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createBrowserUuid always returns a lowercase v4 UUID, the TerminalLeafId shape.
  return createBrowserUuid() as TerminalLeafId
}
