import { makePaneKey } from '../../../../shared/stable-pane-id'
import { resolveAgentPaneAuthorityKey } from '@/store/slices/agent-pane-authority'

/** Detaches a pane the host moved to another tab, leaving its PTY running for that tab. */
export function detachExternallyMovedPane(args: {
  manager: {
    getLeafId: (paneId: number) => string | null
    detachPaneForExternalMove: (paneId: number) => boolean
  }
  paneId: number
  tabId: string
  retireAgentPaneAuthority: (paneKey: string) => void
}): void {
  const leafId = args.manager.getLeafId(args.paneId)
  if (!args.manager.detachPaneForExternalMove(args.paneId) || !leafId) {
    return
  }
  const paneKey = makePaneKey(args.tabId, leafId)
  // Why: the host publishes the agent under its new tab, so this tab's copy is a stale badge.
  // A key this window already moved resolves to the live target, whose records must stay.
  if (resolveAgentPaneAuthorityKey(paneKey) === paneKey) {
    args.retireAgentPaneAuthority(paneKey)
  }
}
