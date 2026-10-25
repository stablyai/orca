import type { AppState } from '../types'
export type LocalRepoCatalogFetchOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }

export const latestLocalRepoCatalogFetchByStore = new WeakMap<
  () => AppState,
  Promise<LocalRepoCatalogFetchOutcome>
>()

export const latestAllHostRepoCatalogGenerationByStore = new WeakMap<() => AppState, number>()

export function startLocalRepoCatalogFetch(
  get: () => AppState
): (outcome: LocalRepoCatalogFetchOutcome) => void {
  let settle: (outcome: LocalRepoCatalogFetchOutcome) => void = () => undefined
  const settlement = new Promise<LocalRepoCatalogFetchOutcome>((resolve) => {
    settle = resolve
  })
  latestLocalRepoCatalogFetchByStore.set(get, settlement)
  return settle
}

export async function awaitLatestLocalRepoCatalogFetch(get: () => AppState): Promise<void> {
  while (true) {
    const pending = latestLocalRepoCatalogFetchByStore.get(get)
    if (!pending) {
      return
    }
    const outcome = await pending
    if (latestLocalRepoCatalogFetchByStore.get(get) === pending) {
      if (outcome.status === 'rejected') {
        throw outcome.reason
      }
      return
    }
  }
}
