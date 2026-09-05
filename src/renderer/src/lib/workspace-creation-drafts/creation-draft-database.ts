import {
  CREATION_DRAFT_LIMIT,
  CreationDraftCapacityError,
  CreationDraftConflictError,
  creationDraftInputSchema,
  creationDraftSchema,
  type CreationDraft,
  type CreationDraftInput
} from './creation-draft-record'
import { transactCreationDrafts } from './creation-draft-connection'

export { CreationDraftConflictError, CreationDraftCapacityError } from './creation-draft-record'

function readDraft(value: unknown, id?: string): CreationDraft | null {
  if (value === undefined) {
    return null
  }
  const draft = creationDraftSchema.parse(value)
  if (id !== undefined && draft.id !== id) {
    throw new Error('Creation draft storage identity mismatch')
  }
  return draft
}

export function getDraft(id: string): Promise<CreationDraft | null> {
  return transactCreationDrafts('readonly', (store, result, fail) => {
    const request = store.get(id)
    request.onsuccess = () => {
      try {
        result(readDraft(request.result, id))
      } catch (error) {
        fail(error)
      }
    }
  })
}

export function listDrafts(): Promise<CreationDraft[]> {
  return transactCreationDrafts('readonly', (store, result, fail) => {
    const request = store.getAll(undefined, CREATION_DRAFT_LIMIT + 1)
    request.onsuccess = () => {
      try {
        if (request.result.length > CREATION_DRAFT_LIMIT) {
          throw new CreationDraftCapacityError()
        }
        result(request.result.map((value: unknown) => creationDraftSchema.parse(value)))
      } catch (error) {
        fail(error)
      }
    }
  })
}

function assertRevision(current: CreationDraft | null, expected: number | null): void {
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
    throw new Error('Invalid expected creation draft revision')
  }
  if ((current?.revision ?? null) !== expected) {
    throw new CreationDraftConflictError(current)
  }
}

export async function saveDraft(
  input: CreationDraftInput,
  expectedRevision: number | null
): Promise<CreationDraft> {
  const parsed = creationDraftInputSchema.parse(input)
  return transactCreationDrafts('readwrite', (store, result, fail) => {
    const request = store.get(parsed.id)
    request.onsuccess = () => {
      try {
        const current = readDraft(request.result, parsed.id)
        assertRevision(current, expectedRevision)
        const next = creationDraftSchema.parse({
          ...parsed,
          revision: (current?.revision ?? 0) + 1
        })
        const write = (): void => {
          store.put(next)
          result(next)
        }
        if (current) {
          write()
          return
        }
        const count = store.count()
        count.onsuccess = () => {
          try {
            if (count.result >= CREATION_DRAFT_LIMIT) {
              throw new CreationDraftCapacityError()
            }
            write()
          } catch (error) {
            fail(error)
          }
        }
      } catch (error) {
        fail(error)
      }
    }
  })
}

export function deleteDraft(id: string, expectedRevision: number): Promise<void> {
  return transactCreationDrafts('readwrite', (store, result, fail) => {
    const request = store.get(id)
    request.onsuccess = () => {
      try {
        const current = readDraft(request.result, id)
        assertRevision(current, expectedRevision)
        store.delete(id)
        result(undefined)
      } catch (error) {
        fail(error)
      }
    }
  })
}
