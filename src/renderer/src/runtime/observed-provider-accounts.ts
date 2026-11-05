import {
  getProviderAccountsOwnerKey,
  watchProviderAccounts,
  type ProviderAccountsSnapshot,
  type ProviderAccountsWatcher
} from './runtime-provider-accounts-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

type Provider = 'claude' | 'codex'
type Answer<P extends Provider> = { accounts: ProviderAccountsSnapshot[P] | null; known: boolean }
type Answers = { [P in Provider]: Answer<P> }
type Resource = {
  answers: Answers
  listeners: Record<Provider, Set<() => void>>
  watcher?: ProviderAccountsWatcher
}
const UNKNOWN: Answers = {
  claude: { accounts: null, known: false },
  codex: { accounts: null, known: false }
}
const resources = new Map<string, Resource>()

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sameProviderAccountData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameProviderAccountData(item, right[index]))
    )
  }
  if (!record(left) || !record(right)) {
    return false
  }
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameProviderAccountData(left[key], right[key]))
  )
}

function publish<P extends Provider>(
  resource: NoInfer<{ answers: Record<P, Answer<P>>; listeners: Resource['listeners'] }>,
  provider: P,
  accounts: ProviderAccountsSnapshot[NoInfer<P>] | null,
  known: boolean
): void {
  const previous = resource.answers[provider]
  const retained = sameProviderAccountData(previous.accounts, accounts)
    ? previous.accounts
    : accounts
  if (retained !== previous.accounts || known !== previous.known) {
    resource.answers[provider] = { accounts: retained, known }
    resource.listeners[provider].forEach((listener) => listener())
  }
}

/** One live host source, with provider equality before notification; no completed-result cache. */
export function observedProviderAccounts<P extends Provider>(
  target: RuntimeClientTarget,
  provider: P
) {
  const key = getProviderAccountsOwnerKey(target)
  let held: Resource | undefined
  return {
    getSnapshot: (): Answer<P> => resources.get(key)?.answers[provider] ?? UNKNOWN[provider],
    setAccounts: (accounts: ProviderAccountsSnapshot[P]): void => {
      if (held && resources.get(key) === held) {
        publish(held, provider, accounts, true)
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      let resource = resources.get(key)
      if (!resource) {
        resource = { answers: { ...UNKNOWN }, listeners: { claude: new Set(), codex: new Set() } }
        resources.set(key, resource)
      }
      held = resource
      resource.listeners[provider].add(listener)
      const current = resource
      if (!current.watcher) {
        const live = (): boolean => resources.get(key) === current
        const lose = (): void => {
          if (live()) {
            publish(current, 'claude', current.answers.claude.accounts, false)
            publish(current, 'codex', current.answers.codex.accounts, false)
          }
        }
        current.watcher = watchProviderAccounts(target, {
          onSnapshot: (snapshot) => {
            if (!live()) {
              return
            }
            for (const name of ['claude', 'codex'] as const) {
              const known = !snapshot.failedProviders?.includes(name)
              publish(current, name, known ? snapshot[name] : current.answers[name].accounts, known)
            }
          },
          onError: lose,
          onClosedAfterSnapshot: lose
        })
      }
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        current.listeners[provider].delete(listener)
        if (
          resources.get(key) === current &&
          current.listeners.claude.size === 0 &&
          current.listeners.codex.size === 0
        ) {
          resources.delete(key)
          current.watcher?.close()
        }
      }
    }
  }
}
