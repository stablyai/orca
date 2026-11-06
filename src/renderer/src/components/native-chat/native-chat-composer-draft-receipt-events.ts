// Who hears about a draft's receipts: keyed removable commit listeners, and the one reconciler
// that rebuilds a receipt's source obligation wherever the draft finds one it did not adopt live.

import { draftCustody, handbackReceiptKey } from './native-chat-composer-draft-custody'
import {
  nativeChatDraftReceiptProgressOf,
  type NativeChatDraftReceiptProgress
} from './native-chat-composer-draft-receipt-proof'
import type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'

/** A listener owns its current scope bucket: disposal and moves touch only that bucket. */
type ReceiptListener = {
  readonly receipt: NativeChatDraftHandbackReceipt
  readonly key: string
  readonly listener: (progress: NativeChatDraftReceiptProgress) => void
  scope: string
  members: Set<ReceiptListener> | null
}

const listeners = new Map<string, Set<ReceiptListener>>()
let reconciler: ((scope: string, receipt: NativeChatDraftHandbackReceipt) => void) | null = null
const queued = new Map<string, readonly [string, NativeChatDraftHandbackReceipt]>()

function bucket(scopeKey: string): Set<ReceiptListener> {
  let members = listeners.get(scopeKey)
  if (!members) {
    members = new Set()
    listeners.set(scopeKey, members)
  }
  return members
}

function leave(entry: ReceiptListener): void {
  const members = entry.members
  entry.members = null
  members?.delete(entry)
  if (members?.size === 0 && listeners.get(entry.scope) === members) {
    listeners.delete(entry.scope)
  }
}

/** One removable entry per subscriber; disposing it twice, or after a move, is inert. */
export function addNativeChatDraftReceiptListener(
  scopeKey: string,
  receipt: NativeChatDraftHandbackReceipt,
  listener: (progress: NativeChatDraftReceiptProgress) => void
): () => void {
  const members = bucket(scopeKey)
  const entry: ReceiptListener = {
    receipt,
    key: handbackReceiptKey(receipt),
    listener,
    scope: scopeKey,
    members
  }
  members.add(entry)
  return () => leave(entry)
}

/** Every proof transition of a scope reaches its own listeners with their current progress. */
export function publishNativeChatDraftReceipts(scopeKey: string): void {
  const members = listeners.get(scopeKey)
  if (!members) {
    return
  }
  for (const entry of Array.from(members)) {
    if (entry.members === members) {
      entry.listener(nativeChatDraftReceiptProgressOf(scopeKey, entry.receipt))
    }
  }
}

const COMPLETED: NativeChatDraftReceiptProgress = {
  backed: true,
  incorporated: true,
  retired: true
}

/** A receipt's retirement completed: its current observers hear so once. Nothing keeps the
 *  result after them; with no observer, nobody is owed it. */
export function deliverNativeChatDraftReceiptCompletion(scopeKey: string, key: string): void {
  const members = listeners.get(scopeKey)
  for (const entry of Array.from(members ?? [])) {
    if (entry.members === members && entry.key === key) {
      entry.listener(COMPLETED)
    }
  }
}

/** Listeners follow their receipts to the destination of a move. */
export function moveNativeChatDraftReceiptListeners(
  from: string,
  to: string,
  receipts: readonly NativeChatDraftHandbackReceipt[]
): void {
  const keys = new Set(receipts.map(handbackReceiptKey))
  const source = listeners.get(from)
  for (const entry of Array.from(source ?? [])) {
    if (keys.has(entry.key)) {
      leave(entry)
      entry.scope = to
      entry.members = bucket(to)
      entry.members.add(entry)
    }
  }
}

export function setNativeChatDraftReceiptReconciler(
  next: (scope: string, receipt: NativeChatDraftHandbackReceipt) => void
): void {
  reconciler = next
  for (const scopeKey of draftCustody.keys()) {
    noticeNativeChatDraftReceipts(scopeKey)
  }
}

/** Every receipt the scope holds reaches the reconciler once, after the current operation. */
export function noticeNativeChatDraftReceipts(
  scopeKey: string,
  receipts: readonly NativeChatDraftHandbackReceipt[] = draftCustody.get(scopeKey)?.handbacks ?? []
): void {
  const wasEmpty = queued.size === 0
  for (const receipt of receipts) {
    queued.set(JSON.stringify([scopeKey, handbackReceiptKey(receipt)]), [scopeKey, receipt])
  }
  if (wasEmpty && queued.size > 0) {
    queueMicrotask(drainReconciler)
  }
}

function drainReconciler(): void {
  const due = [...queued.values()]
  queued.clear()
  for (const [scopeKey, receipt] of due) {
    const key = handbackReceiptKey(receipt)
    // Retired or deleted in the meantime: nothing is owed.
    if (
      reconciler &&
      draftCustody.get(scopeKey)?.handbacks.some((held) => handbackReceiptKey(held) === key)
    ) {
      reconciler(scopeKey, receipt)
    }
  }
}

export function resetNativeChatDraftReceiptEventsForTests(): void {
  listeners.clear()
  queued.clear()
}
