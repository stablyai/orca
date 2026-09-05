const DATABASE_NAME = 'orca-workspace-creation-drafts'
export const DRAFT_STORE = 'drafts'
const OPEN_TIMEOUT_MS = 5000
let opening: Promise<IDBDatabase> | undefined

export function openCreationDraftDatabase(): Promise<IDBDatabase> {
  if (opening) {
    return opening
  }
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    let finished = false
    const request = indexedDB.open(DATABASE_NAME, 1)
    const fail = (error: unknown): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error('Creation draft database open timed out')),
      OPEN_TIMEOUT_MS
    )
    request.onupgradeneeded = () => {
      if (finished) {
        request.transaction?.abort()
        return
      }
      request.result.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
    }
    request.onerror = () => fail(request.error ?? new Error('Creation draft database open failed'))
    request.onblocked = () =>
      fail(
        new Error(
          'Creation draft database upgrade is blocked; retry after closing the other editor'
        )
      )
    request.onsuccess = () => {
      const database = request.result
      if (finished) {
        database.close()
        return
      }
      finished = true
      clearTimeout(timer)
      const forget = (): void => {
        if (opening === pending) {
          opening = undefined
        }
      }
      database.onversionchange = () => {
        database.close()
        forget()
      }
      database.onclose = forget
      resolve(database)
    }
  })
  opening = pending
  void pending.catch(() => {
    if (opening === pending) {
      opening = undefined
    }
  })
  return pending
}

export async function transactCreationDrafts<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void
): Promise<T> {
  const database = await openCreationDraftDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE, mode, { durability: 'strict' })
    let value: T
    let hasValue = false
    let failure: unknown
    const fail = (error: unknown): void => {
      failure ??= error
      try {
        transaction.abort()
      } catch {
        /* A completed transaction cannot be aborted. */
      }
    }
    const timer = setTimeout(() => {
      const error = new Error('Creation draft transaction timed out')
      fail(error)
      reject(error)
    }, 10000)
    transaction.oncomplete = () => {
      clearTimeout(timer)
      if (failure || !hasValue) {
        reject(failure ?? new Error('Creation draft transaction produced no result'))
      } else {
        resolve(value)
      }
    }
    transaction.onabort = () => {
      clearTimeout(timer)
      reject(failure ?? transaction.error ?? new Error('Creation draft transaction aborted'))
    }
    transaction.onerror = () => {
      failure ??= transaction.error
    }
    if (mode === 'readwrite' && transaction.durability !== 'strict') {
      fail(new Error('Strict creation draft durability is unavailable'))
      return
    }
    try {
      work(
        transaction.objectStore(DRAFT_STORE),
        (next) => {
          value = next
          hasValue = true
        },
        fail
      )
    } catch (error) {
      fail(error)
    }
  })
}
