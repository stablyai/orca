import { useSyncExternalStore } from 'react'

type Catalog = { revision: number; languages: readonly string[] }
let snapshot: Catalog = { revision: 0, languages: [] }
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let generation = 0

function publish(languages: string[]): void {
  snapshot = { revision: snapshot.revision + 1, languages }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const plugins = window.api?.plugins
  if (listeners.size === 1 && plugins?.listMarkdownRenderers) {
    const refresh = (): void => {
      const requestGeneration = ++generation
      publish([])
      void plugins
        .listMarkdownRenderers()
        .then((providers) => {
          if (requestGeneration !== generation) {
            return
          }
          const available = providers.filter((provider) => provider.available)
          publish(
            available
              .filter(
                (provider) =>
                  available.filter((other) => other.language === provider.language).length === 1
              )
              .map((provider) => provider.language)
          )
        })
        .catch(() => {
          /* Source remains visible when the catalog cannot be read. */
        })
    }
    unsubscribe = plugins.onChanged(refresh)
    refresh()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      ++generation
      unsubscribe?.()
      unsubscribe = undefined
      snapshot = { revision: snapshot.revision + 1, languages: [] }
    }
  }
}

const read = (): Catalog => snapshot
const readServer = (): Catalog => emptyCatalog
const emptyCatalog: Catalog = { revision: 0, languages: [] }
const skipSubscribe = (): (() => void) => () => {}

export function useNativeMarkdownProviderCatalog(language: string): Catalog {
  const eligible = language !== 'mermaid' && /^[a-z][a-z0-9-]{0,63}$/.test(language)
  return useSyncExternalStore(
    eligible ? subscribe : skipSubscribe,
    eligible ? read : readServer,
    readServer
  )
}
