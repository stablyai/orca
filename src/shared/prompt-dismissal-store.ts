// Dismissed prompt occurrences per chat scope, kept outside any view so a remount cannot reshow
// one. Both apps own one store each; entries die when a view observes their prompt change, or by
// the bound.
import { setBoundedScopeCacheEntry } from './native-chat-scope-cache'

export type PromptDismissalStore<T> = {
  subscribe: (listener: () => void) => () => void
  read: (scopeKey: string) => T | undefined
  write: (scopeKey: string, dismissal: T) => void
  forget: (scopeKey: string) => void
  forgetWhere: (match: (scopeKey: string) => boolean) => void
  clearForTests: () => void
}

export function createPromptDismissalStore<T>(): PromptDismissalStore<T> {
  const dismissals = new Map<string, T>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    read: (scopeKey) => dismissals.get(scopeKey),
    write: (scopeKey, dismissal) => {
      setBoundedScopeCacheEntry(dismissals, scopeKey, dismissal)
      notify()
    },
    forget: (scopeKey) => {
      if (dismissals.delete(scopeKey)) {
        notify()
      }
    },
    forgetWhere: (match) => {
      const stale = [...dismissals.keys()].filter(match)
      for (const scopeKey of stale) {
        dismissals.delete(scopeKey)
      }
      if (stale.length > 0) {
        notify()
      }
    },
    clearForTests: () => dismissals.clear()
  }
}
