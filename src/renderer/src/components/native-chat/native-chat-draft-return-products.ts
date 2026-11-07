import type {
  DraftRecord,
  AppendBeforeLoad,
  UnconfirmedDraftChange
} from './native-chat-composer-draft-memory'

export type NativeChatDraftReturnProduct = {
  scope: string
  before: DraftRecord | undefined
  after?: DraftRecord
  sources: readonly object[]
  sourceRecord?: DraftRecord
  sourceScope?: string
  operations: (AppendBeforeLoad | UnconfirmedDraftChange)[]
  journal: unknown[]
}
export type NativeChatDraftReturnTransfer = {
  permission: object
  from: string
  to: string
  chips: readonly object[]
  pastes: readonly object[]
}
export type NativeChatDraftReturnEvent =
  | NativeChatDraftReturnProduct
  | NativeChatDraftReturnTransfer
type Observer = (event: NativeChatDraftReturnEvent) => void
const observers = new WeakMap<object, Set<Observer>>()
const operationProducts = new WeakMap<object, NativeChatDraftReturnProduct>()
const recordProducts = new WeakMap<DraftRecord, NativeChatDraftReturnProduct>()

/** Observe only handles frozen by a live removal; ordinary editing creates no provenance. */
export function observeNativeChatDraftReturn(source: object, observe: Observer): () => void {
  const held = observers.get(source) ?? new Set<Observer>()
  observers.set(source, held)
  held.add(observe)
  return () => {
    held.delete(observe)
    if (held.size === 0) {
      observers.delete(source)
    }
  }
}

function publish(sources: readonly object[], event: NativeChatDraftReturnEvent): void {
  const targets = new Set<Observer>()
  for (const source of sources) {
    observers.get(source)?.forEach((observe) => targets.add(observe))
  }
  targets.forEach((observe) => observe(event))
}

export function beginNativeChatDraftReturn(
  source: object | readonly object[] | undefined,
  scope: string,
  before: DraftRecord | undefined,
  sourceRecord?: DraftRecord,
  sourceScope?: string
): NativeChatDraftReturnProduct | undefined {
  const sources = source ? (Array.isArray(source) ? source : [source]) : []
  if (!sources.some((held) => observers.get(held)?.size)) {
    return undefined
  }
  return { scope, before, sources, sourceRecord, sourceScope, operations: [], journal: [] }
}

/** Publish at record installation, before listeners can make a nested independent edit. */
export function commitNativeChatDraftReturn(
  product: NativeChatDraftReturnProduct | undefined,
  after: DraftRecord | undefined
): void {
  if (!product) {
    return
  }
  product.after = after
  if (after) {
    recordProducts.set(after, product)
  }
  publish(product.sources, product)
}

export function transferNativeChatDraftReturn(transfer: NativeChatDraftReturnTransfer): void {
  publish([transfer.permission], transfer)
}

export function nativeChatDraftRecordReturn(record: DraftRecord | undefined) {
  return record && recordProducts.get(record)
}

export function recordNativeChatDraftReturnOperation(
  product: NativeChatDraftReturnProduct | undefined,
  operation: AppendBeforeLoad | UnconfirmedDraftChange
): void {
  if (!product) {
    return
  }
  product.operations.push(operation)
  operationProducts.set(operation, product)
}

export function journalNativeChatDraftReturnOperation(operation: object, entry: unknown): void {
  operationProducts.get(operation)?.journal.push(entry)
}

export function releaseNativeChatDraftReturn(product: NativeChatDraftReturnEvent): void {
  if ('permission' in product) {
    return
  }
  if (product.after && recordProducts.get(product.after) === product) {
    recordProducts.delete(product.after)
  }
}
