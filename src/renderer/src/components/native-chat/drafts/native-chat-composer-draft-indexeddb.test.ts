// Count saves only after transaction completion; queued puts can still be lost before commit.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'

type FakeTransaction = {
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
  error: Error | null
  objectStore: () => FakeStore
  commit: () => void
}
type FakeStore = {
  put: (value: unknown, key: string) => object
  delete: (key: string) => object
  get: (key: string) => { result: unknown; onsuccess: (() => void) | null }
}

function fakeDatabase(): {
  factory: IDBFactory
  transactions: FakeTransaction[]
  puts: unknown[]
} {
  const transactions: FakeTransaction[] = []
  const puts: unknown[] = []
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const store: FakeStore = {
        put: (value) => {
          puts.push(value)
          return {}
        },
        delete: () => ({}),
        get: () => {
          const request: { result: unknown; onsuccess: (() => void) | null } = {
            result: undefined,
            onsuccess: null
          }
          queueMicrotask(() => request.onsuccess?.())
          return request
        }
      }
      const transaction: FakeTransaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: () => store,
        commit: () => {}
      }
      transactions.push(transaction)
      return transaction
    }
  }
  const factory = {
    open: () => {
      const request: { result: typeof database; onsuccess: (() => void) | null } = {
        result: database,
        onsuccess: null
      }
      queueMicrotask(() => request.onsuccess?.())
      return request
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in exposing only the calls the adapter makes.
  return { factory: factory as unknown as IDBFactory, transactions, puts }
}

const settledYet = async (promise: Promise<void>): Promise<boolean> => {
  let settled = false
  void promise.then(() => (settled = true))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return settled
}

describe('the IndexedDB draft storage', () => {
  describe('through the draft store', () => {
    const loaded: { clearNativeChatComposerDraftsForTests: () => void }[] = []
    afterEach(() => {
      for (const store of loaded.splice(0)) {
        store.clearNativeChatComposerDraftsForTests()
      }
    })

    async function storeOn(factory: IDBFactory) {
      vi.resetModules()
      const storageModule = await import('./native-chat-composer-draft-storage')
      storageModule.setNativeChatComposerDraftStorageForTests(
        createIndexedDbNativeChatComposerDraftStorage(factory)
      )
      const load = await import('./native-chat-composer-draft-load')
      const persistence = await import('./native-chat-composer-draft-persistence')
      const reset = await import('./native-chat-draft-reset')
      loaded.push(reset)
      return { load, persistence, drafts: await import('./native-chat-draft-views') }
    }

    it('reports a scope’s write settled true only at its transaction’s complete', async () => {
      const { factory, transactions } = fakeDatabase()
      const { load, persistence, drafts } = await storeOn(factory)
      // The fake cannot load, so append must atomically update storage before hydration finishes.
      void load.hydrateNativeChatComposerDrafts()
      drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
      const settled = persistence.nativeChatComposerDraftWriteSettled('agent-session:s1')

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await settledYet(settled.then(() => {}))).toBe(false)
      const write = transactions.at(-1)!
      write.oncomplete?.()
      await expect(settled).resolves.toBe(true)
    })

    it('reports false when the scope’s transaction aborts', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { factory, transactions } = fakeDatabase()
      const { load, persistence, drafts } = await storeOn(factory)
      void load.hydrateNativeChatComposerDrafts()
      drafts.appendNativeChatDraftCache('agent-session:s1', 'returned by Stop')
      const settled = persistence.nativeChatComposerDraftWriteSettled('agent-session:s1')

      await new Promise((resolve) => setTimeout(resolve, 0))
      const write = transactions.at(-1)!
      write.error = new Error('QuotaExceededError')
      write.onabort?.()
      await expect(settled).resolves.toBe(false)
      warn.mockRestore()
    })
  })
})
