// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type {
  DashboardTaskNote,
  DashboardTaskNoteChange,
  DashboardTaskNotes
} from '../../../../shared/dashboard-task-notes'
import { createFallbackProxy } from '../../web/preload-api/web-fallback-api'
import { taskNoteIdentity, taskObservation, currentTaskNote } from './agent-task-status'
import { useDashboardTaskNotes } from './use-dashboard-task-notes'

const card: DashboardCard = {
  paneKey: 'pane',
  ptyId: null,
  agentType: 'codex',
  bucket: 'done',
  dotState: 'done',
  task: '',
  repoId: 'repo',
  worktreeId: 'folder',
  tabId: 'tab',
  leafId: null,
  repoName: 'Repo',
  worktreeName: 'Folder',
  startedAt: 10,
  finishedAt: 20,
  stateChangedAt: 20,
  unseen: true
}
const key = taskNoteIdentity(card)
const note: DashboardTaskNote = {
  status: 'verified',
  title: 'Reviewed',
  summary: '',
  nextStep: '',
  owner: '',
  reviewReference: 'review.md',
  observation: taskObservation(card),
  savedAt: 21
}
const legacyKey = `orca:dashboard-task-note:v1:${key}`
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function nativeApi(get: () => Promise<DashboardTaskNotes>) {
  const listeners = new Set<(change: DashboardTaskNoteChange) => void>()
  const changed = (change: DashboardTaskNoteChange): void => {
    listeners.forEach((listener) => listener(change))
  }
  const api = {
    storage: 'profile',
    get,
    set: vi.fn(async (change: DashboardTaskNoteChange) => {
      changed(change)
      return change
    }),
    onChanged: (listener: (change: DashboardTaskNoteChange) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  vi.stubGlobal('api', { dashboard: { taskNotes: api } })
  return { api, changed }
}
beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('dashboard note synchronization', () => {
  it('keeps a change arriving before initial load resolves and invalidates stale observations', async () => {
    const load = deferred<DashboardTaskNotes>()
    const { changed } = nativeApi(() => load.promise)
    const { result } = renderHook(useDashboardTaskNotes)
    act(() => changed({ key, note }))
    await act(async () => {
      load.resolve({ [key]: { ...note, title: 'Stale snapshot' } })
    })
    expect(result.current.notes[key]).toEqual(note)
    expect(
      currentTaskNote({ ...card, stateChangedAt: 30 }, result.current.notes[key])
    ).toBeUndefined()
  })

  it('shares main/popout changes in both directions and preserves different keys', async () => {
    nativeApi(async () => ({}))
    const main = renderHook(useDashboardTaskNotes)
    const popout = renderHook(useDashboardTaskNotes)
    await act(async () => {})
    await act(async () => {
      await main.result.current.saveNote(card, note)
    })
    expect(popout.result.current.notes[key]).toEqual(note)
    const other = { ...card, paneKey: 'other' }
    await act(async () => {
      await popout.result.current.saveNote(other, { ...note, title: 'Other' })
    })
    expect(main.result.current.notes).toEqual({
      [key]: note,
      [taskNoteIdentity(other)]: { ...note, title: 'Other' }
    })
    expect(popout.result.current.notes).toEqual(main.result.current.notes)
  })

  it('imports missing legacy notes without deleting their source or overwriting authoritative notes', async () => {
    localStorage.setItem(legacyKey, JSON.stringify(note))
    const { api } = nativeApi(async () => ({}))
    const first = renderHook(useDashboardTaskNotes)
    await waitFor(() => expect(first.result.current.notes[key]).toEqual(note))
    expect(api.set).toHaveBeenCalledWith({ key, note, mode: 'import-if-missing' })
    expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(note))
    first.unmount()
    const authoritative = { ...note, title: 'Newer saved task' }
    api.get = async () => ({ [key]: authoritative })
    api.set.mockClear()
    const second = renderHook(useDashboardTaskNotes)
    await waitFor(() => expect(second.result.current.notes[key]).toEqual(authoritative))
    expect(api.set).not.toHaveBeenCalled()
  })

  it('keeps browser/fixture storage working even with a fabricated web API proxy', async () => {
    vi.stubGlobal('api', createFallbackProxy([]))
    const first = renderHook(useDashboardTaskNotes)
    await act(async () => {
      await first.result.current.saveNote(card, note)
    })
    expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(note))
    first.unmount()
    expect(renderHook(useDashboardTaskNotes).result.current.notes[key]).toEqual(note)
  })

  it('reports a failed initial read without falling back to a separate desktop store', async () => {
    localStorage.setItem(legacyKey, JSON.stringify(note))
    const { api } = nativeApi(async () => {
      throw new Error('unavailable')
    })
    const { result } = renderHook(useDashboardTaskNotes)
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.notes).toEqual({})
    expect(api.set).not.toHaveBeenCalled()
  })
})
