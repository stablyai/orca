import type {
  HostStatusReplacement,
  HostStatusState
} from '../slices/runtime-status/host-status-transaction-draft'

/** One store's status write in flight; reused across that store's writes, so a write allocates none. */
export type StatusTransaction = {
  /** The state this write's updater reads; a draft staged against any other state is not this write's. */
  base: HostStatusState | undefined
  hostStatuses: readonly HostStatusReplacement[] | undefined
}

let open: StatusTransaction | undefined

export function createStatusTransaction(): StatusTransaction {
  return { base: undefined, hostStatuses: undefined }
}

/** Makes `transaction` the one updaters stage into, returning the one it replaces. */
export function swapOpenStatusTransaction(
  transaction: StatusTransaction | undefined
): StatusTransaction | undefined {
  const previous = open
  open = transaction
  return previous
}

/** The transaction whose updater is reading `state`, when a status transaction boundary owns the write. */
export function openStatusTransactionFor(state: HostStatusState): StatusTransaction | undefined {
  return open?.base === state ? open : undefined
}
