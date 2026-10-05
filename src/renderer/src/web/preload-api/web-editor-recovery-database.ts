import { z } from 'zod'
import { replayEditorRecoveryTextPatches } from '../../../../shared/editor-recovery-text-patch'
import {
  editorRecoveryDraftSchema,
  editorRecoveryEntrySchema,
  editorRecoveryStatusSchema,
  editorRecoveryResourceKey,
  type EditorRecoveryAck,
  type EditorRecoveryChange,
  type EditorRecoveryDraft,
  type EditorRecoveryEntry
} from '../../../../shared/editor-recovery'

const revisionSchema = z.object({
  revision: z.number().int().positive(),
  state: z.enum(['active', 'retained', 'resolved'])
})

function requestValue(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Recovery storage request failed'))
  })
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Recovery storage transaction aborted'))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Recovery storage transaction failed'))
  })
}

/** Keep metadata separate so opening the recovery list never reads all draft bodies. */
export class WebEditorRecoveryDatabase {
  private opening: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise((resolve, reject) => {
      let blocked = false
      const request = indexedDB.open('orca-editor-recovery', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries', { keyPath: 'id' })
        request.result.createObjectStore('contents')
      }
      request.onsuccess = () => {
        const database = request.result
        if (blocked) {
          database.close()
          return
        }
        database.onversionchange = () => {
          database.close()
          this.opening = null
        }
        resolve(database)
      }
      request.onerror = () => {
        this.opening = null
        reject(request.error)
      }
      request.onblocked = () => {
        blocked = true
        this.opening = null
        reject(new Error('Close other recovery views and retry.'))
      }
    }))
  }

  async list(): Promise<EditorRecoveryEntry[]> {
    const database = await this.open()
    const transaction = database.transaction('entries', 'readonly')
    const rows = await requestValue(transaction.objectStore('entries').getAll())
    return z
      .array(z.unknown())
      .parse(rows)
      .flatMap((row) =>
        revisionSchema.parse(row).state === 'resolved' ? [] : [editorRecoveryEntrySchema.parse(row)]
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  }

  async readMany(ids: readonly string[]): Promise<(EditorRecoveryDraft | null)[]> {
    const database = await this.open()
    const transaction = database.transaction(['entries', 'contents'], 'readonly')
    const reads = ids.map((id) =>
      Promise.all([
        requestValue(transaction.objectStore('entries').get(id)),
        requestValue(transaction.objectStore('contents').get(id))
      ])
    )
    return Promise.all(
      reads.map(async (read) => {
        const [entry, content] = await read
        if (entry === undefined || revisionSchema.parse(entry).state === 'resolved') {
          return null
        }
        return editorRecoveryDraftSchema.parse({
          ...editorRecoveryEntrySchema.parse(entry),
          content
        })
      })
    )
  }
  async status(ids: readonly string[]) {
    if (ids.length === 0) {
      return []
    }
    const database = await this.open()
    const transaction = database.transaction('entries', 'readonly')
    const rows = await Promise.all(
      ids.map((id) => requestValue(transaction.objectStore('entries').get(id)))
    )
    return rows.flatMap((row) => (row === undefined ? [] : [editorRecoveryStatusSchema.parse(row)]))
  }

  async apply(
    changes: readonly EditorRecoveryChange[],
    imported = false
  ): Promise<EditorRecoveryAck[]> {
    const database = await this.open()
    const transaction = database.transaction(['entries', 'contents'], 'readwrite', {
      durability: 'strict'
    })
    const completion = completed(transaction)
    completion.catch(() => {})
    const entries = transaction.objectStore('entries')
    const contents = transaction.objectStore('contents')
    const acknowledgements: EditorRecoveryAck[] = []
    try {
      for (const change of changes) {
        const raw = await requestValue(entries.get(change.id))
        const current = raw === undefined ? null : revisionSchema.parse(raw)
        if ((current?.revision ?? 0) !== change.expectedRevision || current?.state === 'resolved') {
          acknowledgements.push({ id: change.id, revision: null })
          continue
        }
        const revision = change.expectedRevision + 1
        if (change.kind === 'put' || change.kind === 'patch') {
          let content: string
          if (change.kind === 'patch') {
            const saved = z.string().parse(await requestValue(contents.get(change.id)))
            if (
              saved.length !== change.baseLength ||
              editorRecoveryResourceKey(editorRecoveryEntrySchema.parse(raw)) !==
                editorRecoveryResourceKey(change.metadata)
            ) {
              acknowledgements.push({ id: change.id, revision: null })
              continue
            }
            content = replayEditorRecoveryTextPatches(saved, [change])
          } else {
            content = change.content
          }
          entries.put({
            ...change.metadata,
            id: change.id,
            revision,
            updatedAt: imported ? 0 : Date.now(),
            state: change.state,
            byteLength: new Blob([content]).size
          })
          contents.put(content, change.id)
        } else if (change.kind === 'retain') {
          entries.put({
            ...editorRecoveryEntrySchema.parse(raw),
            revision,
            state: 'retained',
            updatedAt: Date.now()
          })
        } else {
          entries.put({ id: change.id, revision, state: 'resolved' })
          contents.delete(change.id)
        }
        acknowledgements.push({ id: change.id, revision })
      }
      await completion
      return acknowledgements
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        /* The browser may have aborted it already. */
      }
      throw error
    }
  }
}
