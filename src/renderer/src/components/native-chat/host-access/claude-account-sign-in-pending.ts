import { useSyncExternalStore } from 'react'

// A login is per account, not per chat: a second press from any chat or tab would cancel the first one.
const signingIn = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Claims the account's sign-in; false while one is already running. */
export function beginClaudeAccountSignIn(accountId: string): boolean {
  if (signingIn.has(accountId)) {
    return false
  }
  signingIn.add(accountId)
  notify()
  return true
}

export function endClaudeAccountSignIn(accountId: string): void {
  if (signingIn.delete(accountId)) {
    notify()
  }
}

export function useClaudeAccountSigningIn(accountId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => accountId !== null && signingIn.has(accountId))
}
