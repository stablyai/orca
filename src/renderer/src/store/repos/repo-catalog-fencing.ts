import type { AppState } from '../types'
export type LocalRepoCatalogFetchOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown }

export const latestLocalRepoCatalogFetchByStore = new WeakMap<
  () => AppState,
  Promise<LocalRepoCatalogFetchOutcome>
>()

export const latestRepoCatalogGenerationByHostByStore = new WeakMap<
  () => AppState,
  Map<string, number>
>()

export const latestAllHostRepoCatalogGenerationByStore = new WeakMap<() => AppState, number>()

const firstLocalRepoCatalogFetchByStore = new WeakMap<
  () => AppState,
  { registered: Promise<void>; markRegistered: () => void }
>()

function awaitLocalRepoCatalogFetchRegistration(get: () => AppState): Promise<void> {
  let first = firstLocalRepoCatalogFetchByStore.get(get)
  if (!first) {
    let markRegistered: () => void = () => undefined
    const registered = new Promise<void>((resolve) => {
      markRegistered = resolve
    })
    first = { registered, markRegistered }
    firstLocalRepoCatalogFetchByStore.set(get, first)
  }
  return first.registered
}

export function startLocalRepoCatalogFetch(
  get: () => AppState
): (outcome: LocalRepoCatalogFetchOutcome) => void {
  let settle: (outcome: LocalRepoCatalogFetchOutcome) => void = () => undefined
  const settlement = new Promise<LocalRepoCatalogFetchOutcome>((resolve) => {
    settle = resolve
  })
  latestLocalRepoCatalogFetchByStore.set(get, settlement)
  firstLocalRepoCatalogFetchByStore.get(get)?.markRegistered()
  return settle
}

/** Resolves once the newest local catalog fetch settles; waits for one to start if none has. */
export async function awaitLatestLocalRepoCatalogFetch(get: () => AppState): Promise<void> {
  while (true) {
    const pending = latestLocalRepoCatalogFetchByStore.get(get)
    if (!pending) {
      // Why wait, not return: runtime fetches never register, so local repos are not loaded yet.
      await awaitLocalRepoCatalogFetchRegistration(get)
      continue
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

export function claimRepoCatalogGeneration(
  get: () => AppState,
  hostId: string,
  generation: number
): void {
  let generations = latestRepoCatalogGenerationByHostByStore.get(get)
  if (!generations) {
    generations = new Map()
    latestRepoCatalogGenerationByHostByStore.set(get, generations)
  }
  if ((generations.get(hostId) ?? 0) < generation) {
    generations.set(hostId, generation)
  }
}

export function isLatestRepoCatalogGeneration(
  get: () => AppState,
  hostId: string,
  generation: number
): boolean {
  return latestRepoCatalogGenerationByHostByStore.get(get)?.get(hostId) === generation
}
