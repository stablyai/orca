import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'

// Why: a cleanup reconcile swaps the shown array without being a user edit. Rollback follows these
// swaps so a queued write still undoes its own change; a later user edit breaks the chain and wins.
const reconciledSuccessor = new WeakMap<DiffComment[], DiffComment[]>()

export function latestReconciled(list: DiffComment[]): DiffComment[] {
  let current = list
  for (let next = reconciledSuccessor.get(current); next; next = reconciledSuccessor.get(current)) {
    current = next
  }
  return current
}

export function recordReconciledSwap(previous: DiffComment[], next: DiffComment[]): void {
  reconciledSuccessor.set(previous, next)
}
