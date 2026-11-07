// The real adapter owns get/update/commit; this fixture supplies asynchronous IDB requests.
export function nativeChatDraftTestDatabase(): IDBFactory {
  const rows = new Map<string, unknown>()
  const request = (result: unknown) => {
    const pending: { result: unknown; onsuccess: (() => void) | null } = { result, onsuccess: null }
    queueMicrotask(() => pending.onsuccess?.())
    return pending
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction: {
        oncomplete: (() => void) | null
        commit: () => void
        objectStore: () => {
          get: (key: string) => ReturnType<typeof request>
          getAllKeys: () => ReturnType<typeof request>
          getAll: () => ReturnType<typeof request>
          put: (value: unknown, key: string) => Map<string, unknown>
          delete: (key: string) => boolean
        }
      } = {
        oncomplete: null,
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
