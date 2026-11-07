// The real adapter owns get/update/commit; this fixture supplies asynchronous IDB requests.
export function nativeChatDraftTestDatabase(): IDBFactory {
  const rows = new Map<string, unknown>()
  const request = (result: unknown) => {
    const pending = { result, onsuccess: null as (() => void) | null }
    queueMicrotask(() => pending.onsuccess?.())
    return pending
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = {
        oncomplete: null as (() => void) | null,
        commit: () => queueMicrotask(() => transaction.oncomplete?.()),
        objectStore: () => ({
          get: (key: string) => request(structuredClone(rows.get(key))),
          getAllKeys: () => request([...rows.keys()]),
          getAll: () => request(structuredClone([...rows.values()])),
          put: (value: unknown, key: string) => rows.set(key, structuredClone(value)),
          delete: (key: string) => rows.delete(key)
        })
      }
      return transaction
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: implements the adapter's asynchronous request/transaction surface only.
  return { open: () => request(database) } as unknown as IDBFactory
}
