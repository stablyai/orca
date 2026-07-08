export function createMemoryStorage(): Storage {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}

export function installWindowLocalStorage(storage: Storage = createMemoryStorage()): Storage {
  // Why: Node 25 exposes a non-DOM localStorage object unless a storage file is configured.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })
  return storage
}
