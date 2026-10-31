import type { Terminal } from '@xterm/xterm'
import {
  indexedDbKittyReplayStore,
  MAX_RECORDS,
  pruneKittyReplayRecords,
  snapshotSchema,
  type KittyImageSnapshot,
  type KittyReplayStore,
  type ReplayChange
} from './terminal-kitty-replay-storage'

export { indexedDbKittyReplayStore, pruneKittyReplayRecords }
export type { KittyImageSnapshot, KittyReplayStore }

export function createKittyReplayCache(store: KittyReplayStore) {
  const changes = new Map<string, ReplayChange & { revision: symbol }>()
  const barriers = new Map<string, symbol>()
  const reads = new Map<string, Set<{ invalidated: boolean }>>()
  let recoveryDisabled = false
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let warned = false
  const warn = (error: unknown) => {
    if (!warned) {
      console.warn('[terminal] image replay cache unavailable', error)
    }
    warned = true
  }
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (changes.size) {
      const batch = [...changes.values()]
      changes.clear()
      pending = pending
        .then(async () => {
          await store.write(batch.map(({ scope, id, record }) => ({ scope, id, record })))
          for (const change of batch) {
            const key = JSON.stringify([change.scope, change.id])
            if (barriers.get(key) === change.revision) {
              barriers.delete(key)
            }
          }
        })
        .catch((error: unknown) => {
          warn(error)
          if (barriers.size > MAX_RECORDS) {
            recoveryDisabled = true
            barriers.clear()
            for (const change of changes.values()) {
              change.record = undefined
            }
          }
        })
    }
    return pending
  }
  return {
    flush,
    async read(scope: string, id: number) {
      await flush()
      const key = JSON.stringify([scope, id])
      if (recoveryDisabled || barriers.has(key)) {
        return undefined
      }
      const lookup = { invalidated: false }
      let active = reads.get(key)
      if (!active) {
        active = new Set()
        reads.set(key, active)
      }
      active.add(lookup)
      try {
        const snapshot = await store.read(scope, id).catch((error: unknown) => {
          warn(error)
          return undefined
        })
        return lookup.invalidated || recoveryDisabled || barriers.has(key) ? undefined : snapshot
      } finally {
        active.delete(lookup)
        if (!active.size) {
          reads.delete(key)
        }
      }
    },
    save(scope: string, id: number, snapshot?: KittyImageSnapshot) {
      const parsed = snapshotSchema.safeParse(snapshot)
      const record =
        !recoveryDisabled && parsed.success && parsed.data.image.id === id
          ? { scope, id, snapshot: parsed.data, touched: Date.now() }
          : undefined
      const key = JSON.stringify([scope, id])
      const revision = Symbol()
      if (!recoveryDisabled) {
        barriers.set(key, revision)
      }
      for (const lookup of reads.get(key) ?? []) {
        lookup.invalidated = true
      }
      changes.set(key, { scope, id, record, revision })
      timer ??= setTimeout(() => {
        void flush()
      }, 100)
    }
  }
}

const cache = createKittyReplayCache(indexedDbKittyReplayStore)
const scopes = new WeakMap<Terminal, string>()
const resets = new WeakMap<Terminal, () => void>()

export function setTerminalKittyReplayScope(terminal: Terminal, scope: string | null): void {
  const previous = scopes.get(terminal)
  if (previous === scope) {
    return
  }
  if (previous) {
    resets.get(terminal)?.()
  }
  if (scope) {
    scopes.set(terminal, scope)
  } else {
    scopes.delete(terminal)
  }
}

export function bindTerminalKittyReplayReset(terminal: Terminal, reset: () => void): () => void {
  resets.set(terminal, reset)
  return () => {
    if (resets.get(terminal) === reset) {
      resets.delete(terminal)
    }
    void cache.flush()
  }
}

export async function readTerminalKittyImage(
  terminal: Terminal,
  id: number
): Promise<KittyImageSnapshot | undefined> {
  const scope = scopes.get(terminal)
  if (!scope) {
    return undefined
  }
  const snapshot = await cache.read(scope, id)
  return scopes.get(terminal) === scope ? snapshot : undefined
}

export function saveTerminalKittyImage(
  terminal: Terminal,
  id: number,
  snapshot?: KittyImageSnapshot
): void {
  const scope = scopes.get(terminal)
  if (scope) {
    cache.save(scope, id, snapshot)
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    void cache.flush()
  })
}
