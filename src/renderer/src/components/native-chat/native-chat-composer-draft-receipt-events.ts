// Who hears about a draft's receipts: keyed removable commit listeners, and the one reconciler
// that rebuilds a receipt's source obligation wherever the draft finds one it did not adopt live.

import {
  draftCustody,
  handbackReceiptKey,
  type NativeChatDraftCustody
} from './native-chat-composer-draft-custody'
import type { NativeChatDraftHandbackReceipt } from './native-chat-composer-draft-storage'

type ReceiptListener = { readonly key: string; readonly listener: (durable: boolean) => void }

const listeners = new Map<string, Set<ReceiptListener>>()
let reconciler: ((scope: string, receipt: NativeChatDraftHandbackReceipt) => void) | null = null
const queued = new Map<string, NativeChatDraftHandbackReceipt>()

function isDurable(custody: NativeChatDraftCustody | undefined, key: string): boolean {
  return Boolean(
    custody?.durable.has(key) &&
    custody.handbacks.some((receipt) => handbackReceiptKey(receipt) === key)
  )
}

/** One removable entry per subscriber; publication happens at the persistence completion point. */
export function addNativeChatDraftReceiptListener(
  scopeKey: string,
  receipt: NativeChatDraftHandbackReceipt,
  listener: (durable: boolean) => void
): () => void {
  const entry: ReceiptListener = { key: handbackReceiptKey(receipt), listener }
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(entry)
  return () => {
    for (const [scope, members] of listeners) {
      if (members.delete(entry) && members.size === 0) {
        listeners.delete(scope)
      }
    }
  }
}

/** A commit attempt for `scopeKey` finished: proof reaches listeners as true, a refusal as false. */
export function publishNativeChatDraftReceipts(scopeKey: string, attempted: boolean): void {
  const custody = draftCustody.get(scopeKey)
  for (const entry of Array.from(listeners.get(scopeKey) ?? [])) {
    const durable = isDurable(custody, entry.key)
    if (durable || attempted) {
      entry.listener(durable)
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
      source?.delete(entry)
      const target = listeners.get(to) ?? new Set()
      listeners.set(to, target)
      target.add(entry)
    }
  }
  if (source?.size === 0) {
    listeners.delete(from)
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
    queued.set(JSON.stringify([scopeKey, handbackReceiptKey(receipt)]), receipt)
  }
  if (wasEmpty && queued.size > 0) {
    queueMicrotask(drainReconciler)
  }
}

function drainReconciler(): void {
  const due = [...queued]
  queued.clear()
  for (const [id, receipt] of due) {
    const scopeKey = JSON.parse(id)[0] as string
    const custody = draftCustody.get(scopeKey)
    // Retired or deleted in the meantime: nothing is owed.
    if (
      reconciler &&
      custody?.handbacks.some((held) => handbackReceiptKey(held) === JSON.parse(id)[1])
    ) {
      reconciler(scopeKey, receipt)
    }
  }
}

export function resetNativeChatDraftReceiptEventsForTests(): void {
  listeners.clear()
  queued.clear()
}
