// App-owned chat-scope dismissals survive view remounts; prompt changes or capacity bounds retire entries.
import { setBoundedScopeCacheEntry } from './native-chat/native-chat-scope-cache'

export type PromptDismissalStore<T> = {
  subscribe: (listener: () => void) => () => void
  read: (scopeKey: string) => T | undefined
  write: (scopeKey: string, dismissal: T) => void
  forget: (scopeKey: string) => void
  forgetWhere: (match: (scopeKey: string) => boolean) => void
  readAsync: (scopeKey: string) => ReadonlySet<string>
  hideAsync: (scopeKey: string, ids: readonly string[]) => void
  forgetAsync: (scopeKey: string) => void
  clearForTests: () => void
}

const EMPTY_HIDDEN_IDS: ReadonlySet<string> = new Set()

export function createPromptDismissalStore<T>(): PromptDismissalStore<T> {
  const dismissals = new Map<string, { prompt?: T; hidden?: ReadonlySet<string> }>()
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
    read: (scopeKey) => dismissals.get(scopeKey)?.prompt,
    write: (scopeKey, dismissal) => {
      setBoundedScopeCacheEntry(dismissals, scopeKey, {
        ...dismissals.get(scopeKey),
        prompt: dismissal
      })
      notify()
    },
    forget: (scopeKey) => {
      const entry = dismissals.get(scopeKey)
      if (entry?.prompt !== undefined) {
        if (entry.hidden) {
          dismissals.set(scopeKey, { hidden: entry.hidden })
        } else {
          dismissals.delete(scopeKey)
        }
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
    readAsync: (scopeKey) => dismissals.get(scopeKey)?.hidden ?? EMPTY_HIDDEN_IDS,
    hideAsync: (scopeKey, ids) => {
      const entry = dismissals.get(scopeKey)
      const hidden = new Set(entry?.hidden)
      for (const id of ids) {
        hidden.add(id)
      }
      if (hidden.size === (entry?.hidden?.size ?? 0)) {
        return
      }
      setBoundedScopeCacheEntry(dismissals, scopeKey, { ...entry, hidden })
      notify()
    },
    forgetAsync: (scopeKey) => {
      const entry = dismissals.get(scopeKey)
      if (!entry?.hidden) {
        return
      }
      if (entry.prompt !== undefined) {
        dismissals.set(scopeKey, { prompt: entry.prompt })
      } else {
        dismissals.delete(scopeKey)
      }
      notify()
    },
    clearForTests: () => dismissals.clear()
  }
}
