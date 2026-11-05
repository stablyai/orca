import {
  applyStorageValue,
  watchPersistedAtoms,
  watchStorageAtoms,
  type OrcaPersistedEntry
} from './declarative-atoms'
import { createPersistQueue } from './declarative-persist-queue'
import type { OrcaBridge, OrcaDisposable } from './declarative-runtime-types'

/**
 * `persist: 'storage'` atoms: loaded from the plugin's storage when created, written back under
 * their key, and re-read when the worker (or another panel) changes that key. Values are stored
 * as they are, without a version, so the worker reads `storage.get(key)` directly.
 */
export function createDeclarativeStorageSync(options: {
  bridge: OrcaBridge | null
  report: (error: unknown) => void
}): {
  /** Persist entries that are not storage atoms, after writing those that are. */
  write(entries: OrcaPersistedEntry[]): OrcaPersistedEntry[]
  /** Resolves once atoms created so far have their stored values. */
  loaded(): Promise<void>
  dispose(): void
} {
  const storage = options.bridge?.storage
  const loads = new Set<Promise<void>>()
  // A local write wins over a read still in flight from before it.
  const writtenSince = new Map<string, number>()
  let generation = 0

  function load(key: string): void {
    if (!storage) {
      return
    }
    const startedAt = generation
    const task = storage
      .get(key)
      .then((value) => {
        if ((writtenSince.get(key) ?? -1) < startedAt) {
          applyStorageValue(key, value ?? undefined)
        }
      })
      .catch(options.report)
      .finally(() => loads.delete(task))
    loads.add(task)
  }

  watchStorageAtoms((key) => {
    generation += 1
    load(key)
  })
  const subscription: OrcaDisposable | undefined = storage?.onDidChange(({ key }) => {
    generation += 1
    load(key)
  })

  return {
    write(entries) {
      const rest: OrcaPersistedEntry[] = []
      for (const entry of entries) {
        if (entry.scope !== 'storage') {
          rest.push(entry)
          continue
        }
        generation += 1
        writtenSince.set(entry.key, generation)
        void storage?.set(entry.key, entry.value).catch(options.report)
      }
      return rest
    },
    loaded: async () => {
      await Promise.all(loads)
    },
    dispose() {
      watchStorageAtoms(null)
      subscription?.dispose()
    }
  }
}

/** Persisted atoms that change: `storage` ones go to the plugin's storage, the rest to Orca. */
export function createDeclarativePersistence(options: {
  bridge: OrcaBridge | null
  report: (error: unknown) => void
  post: (entries: OrcaPersistedEntry[]) => void
}): { flush: () => void; loaded: () => Promise<void>; dispose: () => void } {
  const storageSync = createDeclarativeStorageSync(options)
  const queue = createPersistQueue({
    report: options.report,
    post: (all) => {
      const entries = storageSync.write(all)
      if (entries.length > 0) {
        options.post(entries)
      }
    }
  })
  watchPersistedAtoms(queue.add)
  return {
    flush: queue.flush,
    loaded: storageSync.loaded,
    dispose() {
      watchPersistedAtoms(null)
      storageSync.dispose()
    }
  }
}
