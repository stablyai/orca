// Composer drafts in IndexedDB: one record per scope, keyed by the scope. Kept thin on purpose;
// the draft store holds every rule, and unit tests drive it through the in-memory storage.

import type {
  NativeChatComposerDraftStorage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const DATABASE_NAME = 'orca-native-chat-composer-drafts'
const DATABASE_VERSION = 1
const DRAFTS = 'drafts'

function settled(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Resolves once the transaction is on disk; rejects when it aborts (a full disk included). */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('draft write aborted'))
  })
}

export function createIndexedDbNativeChatComposerDraftStorage(
  factory: IDBFactory
): NativeChatComposerDraftStorage {
  let opened: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DRAFTS)) {
          request.result.createObjectStore(DRAFTS)
        }
      }
      request.onsuccess = () => {
        const db = request.result
        // Why: a newer Orca upgrading the database, or the browser closing it, must not leave
        // every later write failing against a dead connection.
        db.onversionchange = () => db.close()
        db.onclose = () => {
          opened = null
        }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('draft database is blocked'))
    }).catch((error: unknown) => {
      opened = null
      throw error
    })
    return opened
  }

  const change = async (apply: (drafts: IDBObjectStore) => void): Promise<void> => {
    const transaction = (await database()).transaction(DRAFTS, 'readwrite')
    const done = committed(transaction)
    apply(transaction.objectStore(DRAFTS))
    // Why: commit now rather than when the task ends, so a quit right after still lands it.
    transaction.commit?.()
    await done
  }

  return {
    loadAll: async () => {
      const drafts = (await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS)
      const [keys, values] = await Promise.all([
        settled(drafts.getAllKeys()),
        settled(drafts.getAll())
      ])
      const loaded = new Map<string, unknown>()
      if (Array.isArray(keys) && Array.isArray(values)) {
        keys.forEach((key, index) => {
          if (typeof key === 'string') {
            loaded.set(key, values[index])
          }
        })
      }
      return loaded
    },
    read: async (scopeKey) =>
      settled((await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS).get(scopeKey)),
    write: (scopeKey, draft: StoredNativeChatComposerDraft) =>
      change((drafts) => drafts.put(draft, scopeKey)),
    remove: (scopeKeys) =>
      change((drafts) => {
        for (const scopeKey of scopeKeys) {
          drafts.delete(scopeKey)
        }
      }),
    update: async (scopeKey, apply) => {
      const transaction = (await database()).transaction(DRAFTS, 'readwrite')
      const done = committed(transaction)
      const drafts = transaction.objectStore(DRAFTS)
      const read = drafts.get(scopeKey)
      // Why inside the read's callback: the write must land in the same transaction as the read.
      read.onsuccess = () => {
        const next = apply(read.result)
        if (next) {
          drafts.put(next, scopeKey)
        } else {
          drafts.delete(scopeKey)
        }
        transaction.commit?.()
      }
      await done
    }
  }
}
