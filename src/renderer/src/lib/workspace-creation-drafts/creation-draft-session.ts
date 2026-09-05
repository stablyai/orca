import { create } from 'zustand'
import { createBrowserUuid } from '../browser-uuid'
import { deleteDraft, listDrafts, saveDraft } from './creation-draft-database'
import {
  CreationDraftConflictError,
  type CreationDraft,
  type CreationDraftInput
} from './creation-draft-record'

export type CreationDraftEntry = {
  buffer: CreationDraftInput
  storedRevision: number | null
  editVersion: number
  savedVersion: number
  error: string | null
  conflict?: boolean
}

type CreationDraftSession = {
  entries: Record<string, CreationDraftEntry>
  loaded: boolean
  loadError: string | null
  viewedDraftId: string | null
}

export const useCreationDraftSession = create<CreationDraftSession>(() => ({
  entries: {},
  loaded: false,
  loadError: null,
  viewedDraftId: null
}))

const writes = new Map<string, Promise<void>>()
const copies = new Map<string, Promise<string>>()
let loading: Promise<void> | undefined

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fromStored(draft: CreationDraft): CreationDraftEntry {
  const { revision, ...buffer } = draft
  return { buffer, storedRevision: revision, editVersion: 0, savedVersion: 0, error: null }
}

export function loadCreationDrafts(refresh = false): Promise<void> {
  if (loading) {
    return loading
  }
  if (!refresh && useCreationDraftSession.getState().loaded) {
    return Promise.resolve()
  }
  loading = listDrafts()
    .then((drafts) => {
      useCreationDraftSession.setState((state) => {
        const entries = { ...state.entries }
        const storedIds = new Set(drafts.map((draft) => draft.id))
        const isUntouched = (id: string): boolean =>
          entries[id]?.editVersion === 0 && state.viewedDraftId !== id
        for (const id of Object.keys(entries)) {
          if (!storedIds.has(id) && isUntouched(id)) {
            delete entries[id]
          }
        }
        for (const draft of drafts) {
          if (!entries[draft.id]) {
            entries[draft.id] = fromStored(draft)
          }
        }
        return { entries, loaded: true, loadError: null }
      })
    })
    .catch((error: unknown) => {
      useCreationDraftSession.setState({ loadError: message(error) })
    })
    .finally(() => {
      loading = undefined
    })
  return loading
}

export function editCreationDraft(buffer: CreationDraftInput): void {
  const previous = useCreationDraftSession.getState().entries[buffer.id]
  useCreationDraftSession.setState((state) => ({
    entries: {
      ...state.entries,
      [buffer.id]: {
        buffer,
        storedRevision: previous?.storedRevision ?? null,
        editVersion: (previous?.editVersion ?? 0) + 1,
        savedVersion: previous?.savedVersion ?? 0,
        error: null,
        conflict: previous?.conflict
      }
    }
  }))
  void flushCreationDraft(buffer.id)
}

export function bindCreationDraft(
  id: string,
  target: NonNullable<CreationDraftInput['target']>
): boolean {
  const entry = useCreationDraftSession.getState().entries[id]
  if (!entry) {
    return false
  }
  editCreationDraft({ ...entry.buffer, target, updatedAt: Date.now() })
  return true
}

export function flushCreationDraft(id: string): Promise<void> {
  const existing = writes.get(id)
  if (existing) {
    return existing
  }
  const copying = copies.get(id)
  if (copying) {
    return copying.then(
      () => undefined,
      () => undefined
    )
  }
  const work = Promise.resolve()
    .then(async () => {
      while (true) {
        const entry = useCreationDraftSession.getState().entries[id]
        if (!entry || entry.editVersion === entry.savedVersion) {
          return
        }
        try {
          const saved = await saveDraft(entry.buffer, entry.storedRevision)
          useCreationDraftSession.setState((state) => {
            const current = state.entries[id]
            if (!current) {
              return state
            }
            return {
              entries: {
                ...state.entries,
                [id]: {
                  ...current,
                  storedRevision: saved.revision,
                  savedVersion: entry.editVersion,
                  error: null,
                  conflict: false
                }
              }
            }
          })
        } catch (error) {
          useCreationDraftSession.setState((state) => {
            const current = state.entries[id]
            if (!current) {
              return state
            }
            return {
              entries: {
                ...state.entries,
                [id]: {
                  ...current,
                  error: message(error),
                  conflict: current.conflict || error instanceof CreationDraftConflictError
                }
              }
            }
          })
          return
        }
      }
    })
    .finally(() => {
      writes.delete(id)
      const current = useCreationDraftSession.getState().entries[id]
      if (current && !current.error && current.editVersion !== current.savedVersion) {
        void flushCreationDraft(id)
      }
    })
  writes.set(id, work)
  return work
}

export async function discardCreationDraft(id: string): Promise<void> {
  const copying = copies.get(id)
  if (copying) {
    await copying
  }
  await writes.get(id)
  const entry = useCreationDraftSession.getState().entries[id]
  if (!entry) {
    return
  }
  if (entry.storedRevision !== null) {
    try {
      await deleteDraft(id, entry.storedRevision)
    } catch (error) {
      if (error instanceof CreationDraftConflictError) {
        useCreationDraftSession.setState((state) => {
          const current = state.entries[id]
          return current
            ? {
                entries: {
                  ...state.entries,
                  [id]: { ...current, conflict: true, error: message(error) }
                }
              }
            : state
        })
      }
      throw error
    }
  }
  useCreationDraftSession.setState((state) => {
    const entries = { ...state.entries }
    if (entries[id]?.editVersion !== entry.editVersion) {
      entries[id] = { ...entries[id], storedRevision: null, savedVersion: 0 }
      return { entries }
    }
    delete entries[id]
    return { entries, viewedDraftId: state.viewedDraftId === id ? null : state.viewedDraftId }
  })
  // An edit during deletion remains a draft and needs a new durable record.
  if (useCreationDraftSession.getState().entries[id]) {
    await flushCreationDraft(id)
  }
}

export function saveCreationDraftCopy(id: string): Promise<string> {
  const existing = copies.get(id)
  if (existing) {
    return existing
  }
  const copying = Promise.resolve()
    .then(async () => {
      await writes.get(id)
      const copyId = createBrowserUuid()
      let saved: CreationDraft | undefined
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const source = useCreationDraftSession.getState().entries[id]
          if (!source) {
            throw new Error('The draft is no longer available')
          }
          const { target, delivery: _delivery, ...buffer } = source.buffer
          saved = await saveDraft(
            {
              ...buffer,
              id: copyId,
              updatedAt: Date.now(),
              ...(target ? { target: { worktreeId: target.worktreeId } } : {})
            },
            saved?.revision ?? null
          )
          if (useCreationDraftSession.getState().entries[id]?.editVersion !== source.editVersion) {
            continue
          }
          const committed = fromStored(saved)
          useCreationDraftSession.setState((state) => {
            const entries = { ...state.entries, [copyId]: committed }
            delete entries[id]
            return { entries, viewedDraftId: copyId }
          })
          return copyId
        }
        throw new Error('The draft kept changing while saving a copy. Try again.')
      } catch (error) {
        if (saved) {
          try {
            await deleteDraft(copyId, saved.revision)
          } catch {
            const retained = fromStored(saved)
            useCreationDraftSession.setState((state) => ({
              entries: { ...state.entries, [copyId]: retained }
            }))
          }
        }
        useCreationDraftSession.setState((state) => {
          const source = state.entries[id]
          return source
            ? { entries: { ...state.entries, [id]: { ...source, error: message(error) } } }
            : state
        })
        throw error
      }
    })
    .finally(() => {
      copies.delete(id)
    })
  copies.set(id, copying)
  return copying
}
