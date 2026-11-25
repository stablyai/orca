// Per-host private keys are non-extractable: origin scripts can sign but cannot export them.
export type WebDeviceKeyRecord = {
  /** `${hostPublicKeyB64}|${environmentId}` */
  id: string
  privateKey: CryptoKey
  publicKeyB64: string
  state: 'pending' | 'active'
  /** The keyed device row the host forked for this key; set once registration is confirmed. */
  deviceId?: string
  /** The pairing this key belongs to; a re-pair (new revision) starts over with its fresh code. */
  pairingRevision?: number
}

export type WebDeviceKeyStore = {
  get(id: string): Promise<WebDeviceKeyRecord | undefined>
  /** Create-exclusive: false when a record already exists (another tab won the race). */
  add(record: WebDeviceKeyRecord): Promise<boolean>
  put(record: WebDeviceKeyRecord): Promise<void>
  remove(id: string): Promise<void>
}

const DB_NAME = 'orca-web-device-keys'
const STORE_NAME = 'keys'

export function webDeviceKeyId(hostPublicKeyB64: string, environmentId: string): string {
  return `${hostPublicKeyB64}|${environmentId}`
}

export function createIndexedDbWebDeviceKeyStore(factory: IDBFactory): WebDeviceKeyStore {
  let opened: Promise<IDBDatabase> | null = null
  const database = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        opened = null
        reject(request.error ?? new Error('IndexedDB open failed'))
      }
    })
    return opened
  }
  const run = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await database()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode)
      const request = action(transaction.objectStore(STORE_NAME))
      let result: T
      request.onsuccess = () => {
        result = request.result
      }
      // Why oncomplete: a write is durable only once its transaction commits.
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error ?? request.error)
      transaction.onabort = () => reject(transaction.error ?? request.error)
    })
  }
  return {
    get: (id) => run('readonly', (store) => store.get(id)),
    add: async (record) => {
      try {
        await run('readwrite', (store) => store.add(record))
        return true
      } catch (error) {
        if (error instanceof DOMException && error.name === 'ConstraintError') {
          return false
        }
        throw error
      }
    },
    put: async (record) => {
      await run('readwrite', (store) => store.put(record))
    },
    remove: async (id) => {
      await run('readwrite', (store) => store.delete(id))
    }
  }
}

/** Same contract in memory: unit tests, and a browser whose IndexedDB is unavailable. */
export function createMemoryWebDeviceKeyStore(): WebDeviceKeyStore {
  const records = new Map<string, WebDeviceKeyRecord>()
  return {
    get: async (id) => records.get(id),
    add: async (record) => {
      if (records.has(record.id)) {
        return false
      }
      records.set(record.id, record)
      return true
    },
    put: async (record) => {
      records.set(record.id, record)
    },
    remove: async (id) => {
      records.delete(id)
    }
  }
}
