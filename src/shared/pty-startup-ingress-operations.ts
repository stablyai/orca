import type { PtyOwnerBackend } from './pty-owner-backend'
import type {
  PtyStartupIngressOperation,
  PtyIngressSourceSpan
} from './pty-startup-ingress-contract'

export type PtyStartupIngressOperationHost = {
  ownerBackend: PtyOwnerBackend
  keepLiveQueryHold: boolean
  processEchoSpan: (span: PtyIngressSourceSpan) => void
  endQueryAuthority: () => void
  releaseQueryPending: () => void
  releaseEchoPendingOnly: () => void
  releasePendingInSourceOrder: (includeConptyQuery: boolean) => void
  resetDelivery: () => void
  closeDelivery: () => void
  clearDeadline: () => void
  markClosed: () => void
}

export function applyPtyStartupIngressOperation(
  host: PtyStartupIngressOperationHost,
  operation: PtyStartupIngressOperation
): void {
  switch (operation.kind) {
    case 'data':
      host.processEchoSpan(operation.chunk)
      return
    case 'close-query':
      if (host.ownerBackend !== 'windows-conpty') {
        host.endQueryAuthority()
        // Why the echo hold deliberately survives this, unlike `snapshot`: the
        // handoff ends query *authority*, but a reply already on the wire is still
        // Orca's to swallow. Releasing here would show the first half of an echo
        // split across the boundary and orphan the second.
        // Live OSC 10/11 still owns torn queries after this handoff.
        if (!host.keepLiveQueryHold) {
          host.releaseQueryPending()
        }
      }
      // Why: ConPTY cannot safely transfer color-query authority to a downstream view.
      return
    case 'expire':
      host.endQueryAuthority()
      if (host.keepLiveQueryHold) {
        host.releaseEchoPendingOnly()
      } else {
        host.releasePendingInSourceOrder(false)
      }
      host.resetDelivery()
      host.clearDeadline()
      return
    case 'snapshot':
      if (host.keepLiveQueryHold) {
        host.releaseEchoPendingOnly()
        return
      }
      host.releasePendingInSourceOrder(false)
      return
    case 'release-echo':
      host.releasePendingInSourceOrder(false)
      return
    case 'teardown':
      host.endQueryAuthority()
      host.releasePendingInSourceOrder(true)
      host.closeDelivery()
      host.clearDeadline()
      host.markClosed()
  }
}
