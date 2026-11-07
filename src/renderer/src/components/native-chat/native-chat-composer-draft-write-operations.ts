import type { UnconfirmedDraftChange, AppendBeforeLoad } from './native-chat-composer-draft-memory'
export const inFlight = new Set<Promise<boolean>>()
// Per scope, the writes not yet settled: each resolves true once committed, false when refused.
export const scopeWrites = new Map<string, Set<Promise<boolean>>>()
const operations = new Map<string, Set<UnconfirmedDraftChange | AppendBeforeLoad>>()
export function nativeChatComposerDraftOperations(scope: string) {
  return operations.get(scope) ?? new Set<UnconfirmedDraftChange | AppendBeforeLoad>()
}
export const foreignReads = new Map<string, object>()
export function nativeChatComposerDraftForeignRead(scope: string): object | undefined {
  return foreignReads.get(scope)
}
export function supersedeNativeChatComposerDraftRead(
  scope: string,
  read: object | undefined
): void {
  if (read && foreignReads.get(scope) === read) {
    foreignReads.delete(scope)
  }
}
export function nativeChatComposerDraftOperationScopes(): IterableIterator<string> {
  return operations.keys()
}

export function trackNativeChatComposerDraftRemoval(
  scope: string,
  written: Promise<boolean>
): void {
  track(scope, written)
}
export function track(
  scopeKey: string,
  written: Promise<boolean>,
  operation?: UnconfirmedDraftChange | AppendBeforeLoad
): void {
  if (operation) {
    const held = operations.get(scopeKey) ?? new Set()
    operations.set(scopeKey, held)
    held.add(operation)
  }
  inFlight.add(written)
  const pending = scopeWrites.get(scopeKey) ?? new Set()
  scopeWrites.set(scopeKey, pending)
  pending.add(written)
  void written.finally(() => {
    inFlight.delete(written)
    if (operation) {
      const held = operations.get(scopeKey)
      held?.delete(operation)
      if (held?.size === 0) {
        operations.delete(scopeKey)
      }
    }
    pending.delete(written)
    if (pending.size === 0 && scopeWrites.get(scopeKey) === pending) {
      scopeWrites.delete(scopeKey)
    }
  })
}

export function resetNativeChatDraftWriteOperations(): void {
  inFlight.clear()
  scopeWrites.clear()
  operations.clear()
  foreignReads.clear()
}
