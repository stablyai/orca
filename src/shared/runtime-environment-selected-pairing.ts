import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

/** The pairing main itself selected for one local call, before anything about it was awaited.
 *  `crossedRepair`: the answer came from that pairing's successor after a same-host managed
 *  repair, so it speaks for neither pairing alone. Local only: never sent to or by a host. */
export type RuntimeEnvironmentSelectedPairing = { revision: number; crossedRepair?: true }

/** A local runtime-environment call's result: the host's own response, beside main's selection. */
export type RuntimeEnvironmentCallResult<T = unknown> = RuntimeRpcResponse<T> & {
  selectedPairing?: RuntimeEnvironmentSelectedPairing
}
