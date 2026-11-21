import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { replaceMapEntries } from '@/store/record-transitions/keyed-record-transitions'
import {
  openStatusTransactionFor,
  type StatusTransaction
} from '../../status-transaction/status-transaction'

export type HostStatusReplacement = readonly [string, RuntimeEnvironmentStatus | null]
export type HostStatusState = {
  runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
}

/**
 * Stages host status replacements for the write whose updater is reading `state`, alongside `patch`.
 * Stores without a status transaction boundary get the replacements folded into the returned patch.
 */
export function stageHostStatuses<P extends object>(
  state: HostStatusState,
  replacements: readonly HostStatusReplacement[],
  patch: P
): P {
  const transaction = openStatusTransactionFor(state)
  if (!transaction) {
    return {
      ...patch,
      runtimeStatusByEnvironmentId: replaceMapEntries(
        state.runtimeStatusByEnvironmentId,
        replacements
      )
    }
  }
  transaction.hostStatuses = transaction.hostStatuses
    ? [...transaction.hostStatuses, ...replacements]
    : replacements
  return patch
}

/** Commits the staged host statuses into the root write, in the same dispatch as the rest of it. */
export function stageHostStatusDraft(
  transaction: StatusTransaction,
  current: HostStatusState,
  next: HostStatusState
): void {
  if (transaction.hostStatuses) {
    // Replacements were staged against the state the updater read.
    next.runtimeStatusByEnvironmentId = replaceMapEntries(
      current.runtimeStatusByEnvironmentId,
      transaction.hostStatuses
    )
  }
}
