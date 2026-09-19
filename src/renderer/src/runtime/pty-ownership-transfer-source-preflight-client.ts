import type { PtyOwnershipTransferPreflightResult } from '../../../shared/pty-ownership-transfer-orchestration'
import {
  isPtyOwnershipTransferMethodNotFoundError,
  PairedRuntimePtyOwnershipTransferClient
} from './paired-runtime-pty-ownership-transfer-client'
import { callRuntimeRpc } from './runtime-rpc-client'

export { isPtyOwnershipTransferMethodNotFoundError }

export async function preflightPairedRuntimePtyOwnershipTransfer(
  args: {
    ptyId: string
    destinationRuntimeId: string
    signal?: AbortSignal
  },
  dependencies: { callRuntimeRpc: typeof callRuntimeRpc } = { callRuntimeRpc }
): Promise<PtyOwnershipTransferPreflightResult> {
  return new PairedRuntimePtyOwnershipTransferClient(args.ptyId, args.destinationRuntimeId, {
    callRuntimeRpc: dependencies.callRuntimeRpc
  }).preflight({ signal: args.signal })
}
