// Keep persistence thin; the draft store owns merge and lifecycle policy.

import {
  committedTransaction,
  indexedDbConnection,
  settledRequest
} from '@/app-shell/storage/indexeddb-connection'
import type {
  NativeChatComposerDraftStorage,
  StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const DATABASE_NAME = 'orca-native-chat-composer-drafts'
const DATABASE_VERSION = 1
const DRAFTS = 'drafts'

export function createIndexedDbNativeChatComposerDraftStorage(
  factory: IDBFactory
): NativeChatComposerDraftStorage {
  const database = indexedDbConnection(factory, DATABASE_NAME, DATABASE_VERSION, (db) => {
    if (!db.objectStoreNames.contains(DRAFTS)) {
      db.createObjectStore(DRAFTS)
    }
  })

  const change = async (apply: (drafts: IDBObjectStore) => void): Promise<void> => {
    const transaction = (await database()).transaction(DRAFTS, 'readwrite')
    const done = committedTransaction(transaction)
    apply(transaction.objectStore(DRAFTS))
    // Why: commit now rather than when the task ends, so a quit right after still lands it.
    transaction.commit?.()
    await done
  }

  return {
    loadAll: async () => {
      const drafts = (await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS)
      const [keys, values] = await Promise.all([
        settledRequest(drafts.getAllKeys()),
        settledRequest(drafts.getAll())
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
      settledRequest(
        (await database()).transaction(DRAFTS, 'readonly').objectStore(DRAFTS).get(scopeKey)
      ),
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
      const done = committedTransaction(transaction)
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
