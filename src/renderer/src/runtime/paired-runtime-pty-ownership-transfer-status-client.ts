import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferStatusResult } from '../../../shared/pty-ownership-transfer-wire'
import { PairedRuntimePtyOwnershipTransferClient } from './paired-runtime-pty-ownership-transfer-client'
import { callRuntimeRpc } from './runtime-rpc-client'

/** Read-only recovery probe routed to the runtime that owns the scoped PTY handle. */
export async function probePairedRuntimePtyOwnershipTransferStatus(
  args: {
    ptyId: string
    identity: PtyOwnershipTransferIdentity
    timeoutMs?: number
    signal?: AbortSignal
  },
  dependencies: { callRuntimeRpc: typeof callRuntimeRpc } = { callRuntimeRpc }
): Promise<PtyOwnershipTransferStatusResult | null> {
  return new PairedRuntimePtyOwnershipTransferClient(
    args.ptyId,
    args.identity.destinationRuntimeId,
    { callRuntimeRpc: dependencies.callRuntimeRpc }
  ).status(args.identity, { timeoutMs: args.timeoutMs, signal: args.signal })
}
