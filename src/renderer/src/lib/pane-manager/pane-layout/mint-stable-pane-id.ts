import type { TerminalLeafId } from '../../../../../shared/workspace-layout/stable-pane-id'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'

export function mintStablePaneId(): TerminalLeafId {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createBrowserUuid always returns a lowercase v4 UUID, the TerminalLeafId shape.
  return createNonSecureContextUuid() as TerminalLeafId
}
