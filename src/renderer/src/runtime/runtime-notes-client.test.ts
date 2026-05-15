import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeProjectNote,
  deleteRuntimeProjectNote,
  linkRuntimeProjectNote,
  listRuntimeProjectNotes,
  renameRuntimeProjectNote,
  resolveRuntimeNotesPanelState,
  saveRuntimeProjectNote,
  showRuntimeProjectNote
} from './runtime-notes-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const notesList = vi.fn()
const notesShow = vi.fn()
const notesCreate = vi.fn()
const notesSave = vi.fn()
const notesRename = vi.fn()
const notesDelete = vi.fn()
const notesAppend = vi.fn()
const notesSearch = vi.fn()
const notesLink = vi.fn()
const notesPanelState = vi.fn()
const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  notesList.mockReset()
  notesShow.mockReset()
  notesCreate.mockReset()
  notesSave.mockReset()
  notesRename.mockReset()
  notesDelete.mockReset()
  notesAppend.mockReset()
  notesSearch.mockReset()
  notesLink.mockReset()
  notesPanelState.mockReset()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      notes: {
        list: notesList,
        show: notesShow,
        create: notesCreate,
        save: notesSave,
        rename: notesRename,
        delete: notesDelete,
        append: notesAppend,
        search: notesSearch,
        link: notesLink,
        panelState: notesPanelState
      },
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('runtime notes client', () => {
  it('uses local notes IPC when no remote runtime is active', async () => {
    notesList.mockResolvedValue({ notes: [], totalCount: 0, truncated: false })

    await listRuntimeProjectNotes(
      { activeRuntimeEnvironmentId: null },
      { projectId: 'repo-1', worktreeId: 'wt-1', limit: 100 }
    )

    expect(notesList).toHaveBeenCalledWith({
      projectId: 'repo-1',
      worktreeId: 'wt-1',
      limit: 100
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes note reads through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { notes: [], totalCount: 0, truncated: false },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const settings = { activeRuntimeEnvironmentId: 'env-1' }

    await listRuntimeProjectNotes(settings, {
      projectId: 'repo-1',
      worktreeId: 'wt-1',
      limit: 100
    })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-2',
      ok: true,
      result: { note: { id: 'note-1' }, linkKind: null },
      _meta: { runtimeId: 'remote-runtime' }
    })
    await showRuntimeProjectNote(settings, {
      projectId: 'repo-1',
      worktreeId: 'wt-1',
      note: 'note-1'
    })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'note.list',
      params: { worktree: 'wt-1', limit: 100 },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'note.show',
      params: { worktree: 'wt-1', note: 'note-1' },
      timeoutMs: 15_000
    })
  })

  it('routes note mutations through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { note: { id: 'note-1' }, linkKind: 'active' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const settings = { activeRuntimeEnvironmentId: 'env-1' }
    const base = { projectId: 'repo-1', worktreeId: 'wt-1' }

    await createRuntimeProjectNote(settings, { ...base, title: 'Plan', bodyMarkdown: 'body' })
    await saveRuntimeProjectNote(settings, {
      ...base,
      note: 'note-1',
      title: 'Plan',
      bodyMarkdown: 'updated',
      revision: 3,
      makeActive: true
    })
    await renameRuntimeProjectNote(settings, { ...base, note: 'note-1', title: 'Renamed' })
    await deleteRuntimeProjectNote(settings, { ...base, note: 'note-1' })
    await linkRuntimeProjectNote(settings, { ...base, note: 'note-1', kind: 'active' })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'note.create',
      params: {
        worktree: 'wt-1',
        title: 'Plan',
        bodyMarkdown: 'body',
        makeActive: undefined,
        createdBySessionId: undefined
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'note.save',
      params: {
        worktree: 'wt-1',
        note: 'note-1',
        title: 'Plan',
        bodyMarkdown: 'updated',
        revision: 3,
        makeActive: true,
        updatedBySessionId: undefined
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'note.rename',
      params: {
        worktree: 'wt-1',
        note: 'note-1',
        title: 'Renamed',
        updatedBySessionId: undefined
      },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(4, {
      selector: 'env-1',
      method: 'note.delete',
      params: { worktree: 'wt-1', note: 'note-1' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(5, {
      selector: 'env-1',
      method: 'note.link',
      params: { worktree: 'wt-1', note: 'note-1', kind: 'active' },
      timeoutMs: 15_000
    })
  })

  it('routes panel state through the active runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { state: 'emptyDraft', projectId: 'repo-1', worktreeId: 'wt-1' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await resolveRuntimeNotesPanelState(
      { activeRuntimeEnvironmentId: 'env-1' },
      { projectId: 'repo-1', worktreeId: 'wt-1' }
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'note.panelState',
      params: { worktree: 'wt-1' },
      timeoutMs: 15_000
    })
  })

  it('returns noProject for remote panel state without a project/worktree', async () => {
    await expect(
      resolveRuntimeNotesPanelState({ activeRuntimeEnvironmentId: 'env-1' }, {})
    ).resolves.toEqual({ state: 'noProject' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})
