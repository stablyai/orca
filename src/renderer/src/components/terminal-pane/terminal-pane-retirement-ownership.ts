import type { AppState } from '@/store/types'
import {
  getTerminalPtyOwnershipIdentity,
  hasTerminalPtyOwnerOutsidePane
} from '@/store/slices/terminal-tab-retirement'
import type { PtyTransport } from './pty-transport-types'

export type UnboundTerminalPaneRetirement = {
  getState: () => AppState
  tabId: string
  leafId: string
  transport: PtyTransport | undefined
  getTransports: () => ReadonlyMap<number, PtyTransport>
}

export function terminalPaneHasOtherOwner(
  args: Pick<UnboundTerminalPaneRetirement, 'getState' | 'getTransports' | 'tabId'>,
  identity: string,
  worktreeId: string | null,
  excludedLeafId?: string
): boolean {
  const current = args.getState()
  return (
    hasTerminalPtyOwnerOutsidePane(current, identity, args.tabId, excludedLeafId) ||
    [...args.getTransports().values()].some((candidate) => {
      const boundId = candidate.getPtyId()
      return (
        boundId !== null &&
        getTerminalPtyOwnershipIdentity(current, boundId, worktreeId) === identity
      )
    })
  )
}
