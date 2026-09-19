import type { StoreApi } from 'zustand/vanilla'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEditorStore,
  createEditorTabsStore,
  ownedEditorFileId
} from './editor-slice-test-harness'
import { createRecentlyClosedTabsSlice } from './recently-closed-tabs'
import type { AppState } from '../types'
import type { Tab } from '../../../../shared/tab-types'

const { toastErrorMock, toastInfoMock } = vi.hoisted(() => ({
  toastErrorMock: vi.fn(),
  toastInfoMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock, info: toastInfoMock }
}))

const { notifyHostOfMirroredEditorCloseMock } = vi.hoisted(() => ({
  notifyHostOfMirroredEditorCloseMock: vi.fn()
}))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: (...args: unknown[]) =>
    notifyHostOfMirroredEditorCloseMock(...args)
}))

/** Counts how often store code reads `entityId` off a worktree's unified tabs —
 *  a scan-count proxy that pins complexity without timing the wall clock. */
function withCountedEntityIdReads(tabs: readonly Tab[], onRead: () => void): Tab[] {
  return tabs.map((tab) => {
    const { entityId, ...rest } = tab
    return Object.defineProperty(rest, 'entityId', {
      get: () => {
        onRead()
        return entityId
      },
      enumerable: true,
      configurable: true
    }) as Tab
  })
}

/** The cross-type Cmd+Shift+T dispatcher owns the kind stack the editor reopen pops from, so a
 *  test of that handoff needs the real dispatcher rather than a stub. */
function withCrossTypeReopen(store: StoreApi<AppState>): StoreApi<AppState> {
  const { reopenClosedTerminalTab, reopenClosedTab } = createRecentlyClosedTabsSlice(
    store.setState,
    store.getState,
    store
  )
  // Why actions only: spreading the slice's initial state would blank the kind stack a test seeded.
  store.setState({ reopenClosedTerminalTab, reopenClosedTab })
  return store
}

describe('createEditorSlice recently closed editor tabs', () => {
  beforeEach(() => {
    toastInfoMock.mockClear()
  })

  function openMirroredEditor(store: StoreApi<AppState>, filePath: string, preview = false): void {
    store.getState().openFile(
      {
        filePath,
        relativePath: filePath.replace('/repo/', ''),
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mirroredFromRuntimeSession: true,
        mode: 'edit'
      },
      { preview }
    )
  }

  function openLocalEditor(store: StoreApi<AppState>, filePath = '/repo/notes.md'): string {
    return store.getState().openFile({
      filePath,
      relativePath: filePath.replace('/repo/', ''),
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
  }

  /** A draft the restore heal could not give a tab of its own, waiting on the reopen stack. */
  function parkRecoveredDraft(
    store: StoreApi<AppState>,
    dirtyDraftContent: string,
    options: { filePath?: string; lastKnownDiskSignature?: string } = {}
  ): void {
    const filePath = options.filePath ?? '/repo/notes.md'
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [
          {
            filePath,
            relativePath: filePath.replace('/repo/', ''),
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            dirtyDraftContent,
            ...(options.lastKnownDiskSignature
              ? { lastKnownDiskSignature: options.lastKnownDiskSignature }
              : {})
          }
        ]
      },
      // Why: hydration pairs every parked snapshot with a kind entry, so the fixture must too.
      recentlyClosedTabKindsByWorktree: { 'wt-1': ['editor'] }
    })
  }

  it('reopens a closed mirrored editor tab as a local tab', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeFile('/repo/notes.md')

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('restores a parked unsaved buffer when its snapshot carries one', () => {
    const store = createEditorStore()
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [
          {
            filePath: '/repo/notes.md',
            relativePath: 'notes.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            mode: 'edit',
            dirtyDraftContent: 'rescued draft'
          }
        ]
      }
    })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    const restored = store.getState().openFiles[0]
    expect(restored).toMatchObject({ filePath: '/repo/notes.md', isDirty: true })
    expect(store.getState().editorDrafts[restored.id]).toBe('rescued draft')
    expect(restored).not.toHaveProperty('dirtyDraftContent')
  })

  it('applies a recovered draft to a record that is already open and clean', () => {
    const store = createEditorStore()
    const openId = openLocalEditor(store)
    parkRecoveredDraft(store, 'rescued draft')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().editorDrafts[openId]).toBe('rescued draft')
    expect(store.getState().openFiles[0].isDirty).toBe(true)
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([])
  })

  it('never overwrites the unsaved buffer of a record that is already open', () => {
    const store = createEditorStore()
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'live buffer')
    store.getState().markFileDirty(openId, true)
    parkRecoveredDraft(store, 'rescued draft')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().editorDrafts[openId]).toBe('live buffer')
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({ dirtyDraftContent: 'rescued draft' })
    ])
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })

  it('re-verifies the disk baseline a recovered draft derives from', () => {
    const store = createEditorStore()
    parkRecoveredDraft(store, 'rescued draft', { lastKnownDiskSignature: 'sig-1' })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles[0]).toMatchObject({
      lastKnownDiskSignature: 'sig-1',
      pendingDiskBaselineVerification: true
    })
  })

  it('leaves a recovered draft with no baseline out of the conflict scan', () => {
    const store = createEditorStore()
    parkRecoveredDraft(store, 'rescued draft')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    const restored = store.getState().openFiles[0]
    expect(restored.lastKnownDiskSignature).toBeUndefined()
    expect(restored.pendingDiskBaselineVerification).toBeUndefined()
  })

  it("replaces a reused clean record's baseline with the one the recovered draft derives from", () => {
    const store = createEditorStore()
    const openId = openLocalEditor(store)
    store.getState().setLastKnownDiskSignature(openId, 'sig-clean-load')
    parkRecoveredDraft(store, 'rescued draft', { lastKnownDiskSignature: 'sig-draft' })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]).toMatchObject({
      id: openId,
      lastKnownDiskSignature: 'sig-draft',
      pendingDiskBaselineVerification: true
    })
  })

  it('sends a draft that cannot land to the back of both reopen stacks', () => {
    const store = withCrossTypeReopen(createEditorTabsStore())
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'live buffer')
    store.getState().markFileDirty(openId, true)
    parkRecoveredDraft(store, 'rescued draft')
    const parked = store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? []
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [...parked, { ...parked[0], filePath: '/repo/other.md', relativePath: 'other.md' }]
      },
      recentlyClosedTerminalTabsByWorktree: { 'wt-1': [{ startupCwd: '/repo' }] },
      recentlyClosedTabKindsByWorktree: { 'wt-1': ['editor', 'editor', 'terminal'] }
    })

    expect(store.getState().reopenClosedTab('wt-1')).toBe(true)

    // The colliding snapshot moved behind the untouched one, and its kind behind the terminal's.
    expect(
      store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.map((s) => s.filePath)
    ).toEqual(['/repo/other.md', '/repo/notes.md'])
    expect(store.getState().recentlyClosedTabKindsByWorktree['wt-1']).toEqual([
      'editor',
      'terminal',
      'editor'
    ])
    expect(store.getState().editorDrafts[openId]).toBe('live buffer')
  })

  it('lets a later cross-type reopen pass a deferred draft instead of queuing behind it', () => {
    const store = withCrossTypeReopen(createEditorTabsStore())
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'live buffer')
    store.getState().markFileDirty(openId, true)
    parkRecoveredDraft(store, 'rescued draft')
    // The terminal slice is out of this harness, so stand in for the reopen the dispatcher calls.
    const terminalReopenMock = vi.fn(() => true)
    store.setState({
      reopenClosedTerminalTab: terminalReopenMock,
      recentlyClosedTabKindsByWorktree: { 'wt-1': ['editor', 'terminal'] }
    })

    expect(store.getState().reopenClosedTab('wt-1')).toBe(true)
    expect(store.getState().reopenClosedTab('wt-1')).toBe(true)

    expect(terminalReopenMock).toHaveBeenCalledTimes(1)
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({ dirtyDraftContent: 'rescued draft' })
    ])
  })

  it('leaves the live record untouched when a recovered draft collides with its unsaved work', () => {
    const store = createEditorTabsStore()
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'live buffer')
    store.getState().markFileDirty(openId, true)
    store.getState().setLastKnownDiskSignature(openId, 'sig-live')
    const tabCountBefore = (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).length
    const orderBefore = store.getState().tabBarOrderByWorktree['wt-1']
    parkRecoveredDraft(store, 'rescued draft', { lastKnownDiskSignature: 'sig-draft' })
    // The toast names a document the user must act on, so the editor has to come back to the front.
    store.setState({ activeTabType: 'terminal', activeTabTypeByWorktree: { 'wt-1': 'terminal' } })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeTabTypeByWorktree['wt-1']).toBe('editor')
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(tabCountBefore)
    expect(store.getState().editorDrafts[openId]).toBe('live buffer')
    expect(store.getState().openFiles[0]).toMatchObject({ lastKnownDiskSignature: 'sig-live' })
    expect(store.getState().openFiles[0].pendingDiskBaselineVerification).toBeUndefined()
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual(orderBefore)
    expect(store.getState().activeFileId).toBe(openId)
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock).toHaveBeenCalledWith(
      'notes.md is open with unsaved changes. Save or close it, then reopen to recover the parked draft.'
    )
  })

  it('opens no second tab when the colliding snapshot names another group', () => {
    const store = createEditorTabsStore()
    const openId = openLocalEditor(store)
    const firstGroupId = store.getState().groupsByWorktree['wt-1']?.[0]?.id ?? ''
    const secondGroupId = store
      .getState()
      .createEmptySplitGroup('wt-1', firstGroupId, 'right', { activate: false })
    expect(secondGroupId).toBeTruthy()
    expect(secondGroupId).not.toBe(firstGroupId)
    store.getState().setEditorDraft(openId, 'live buffer')
    store.getState().markFileDirty(openId, true)
    parkRecoveredDraft(store, 'rescued draft')
    const parked = (store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? [])[0]
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [{ ...parked, position: { groupId: secondGroupId ?? undefined } }]
      }
    })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(
      (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).filter(
        (tab) => tab.entityId === openId
      )
    ).toHaveLength(1)
  })

  it('leaves the live tab where it is when a recovered draft parks', () => {
    const store = createEditorTabsStore()
    const firstId = openLocalEditor(store, '/repo/first.md')
    const notesId = openLocalEditor(store)
    store.getState().setEditorDraft(notesId, 'live buffer')
    store.getState().markFileDirty(notesId, true)
    store.getState().setTabBarOrder('wt-1', [firstId, notesId])
    parkRecoveredDraft(store, 'rescued draft')
    // The snapshot's position is stale: honouring it would drag the live tab to the front.
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [
          {
            ...(store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? [])[0],
            position: { tabBarIndex: 0 }
          }
        ]
      }
    })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([firstId, notesId])
  })

  it('drops a recovered draft the live record already holds without rewriting its baseline', () => {
    const store = createEditorTabsStore()
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'same draft')
    store.getState().markFileDirty(openId, true)
    store.getState().setLastKnownDiskSignature(openId, 'sig-live')
    parkRecoveredDraft(store, 'same draft', { lastKnownDiskSignature: 'sig-draft' })
    store.setState({ activeTabType: 'terminal', activeTabTypeByWorktree: { 'wt-1': 'terminal' } })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().recentlyClosedTabKindsByWorktree['wt-1']).toEqual(['editor'])
    expect(store.getState().editorDrafts[openId]).toBe('same draft')
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]).toMatchObject({ lastKnownDiskSignature: 'sig-live' })
    expect(store.getState().openFiles[0].pendingDiskBaselineVerification).toBeUndefined()
    expect(store.getState().activeFileId).toBe(openId)
  })

  it('gives a baseline-less live record the equal draft snapshot baseline to verify', () => {
    const store = createEditorTabsStore()
    const openId = openLocalEditor(store)
    store.getState().setEditorDraft(openId, 'same draft')
    store.getState().markFileDirty(openId, true)
    parkRecoveredDraft(store, 'same draft', { lastKnownDiskSignature: 'sig-draft' })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    // Without the baseline the restored draft has nothing the conflict scan can verify it against.
    expect(store.getState().openFiles[0]).toMatchObject({
      lastKnownDiskSignature: 'sig-draft',
      pendingDiskBaselineVerification: true
    })
    expect(store.getState().editorDrafts[openId]).toBe('same draft')
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([])
  })

  it('gives a baseline-less reused alias record the equal draft snapshot baseline', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    try {
      const store = createEditorStore()
      const liveId = store.getState().openFile({
        filePath: '//wsl.localhost/Ubuntu/home/Alice/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      })
      store.getState().setEditorDraft(liveId, 'same draft')
      store.getState().markFileDirty(liveId, true)
      parkRecoveredDraft(store, 'same draft', {
        filePath: '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\notes.md',
        lastKnownDiskSignature: 'sig-draft'
      })

      expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

      expect(store.getState().openFiles).toHaveLength(1)
      expect(store.getState().openFiles[0]).toMatchObject({
        lastKnownDiskSignature: 'sig-draft',
        pendingDiskBaselineVerification: true
      })
      expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('parks a recovered draft rather than feeding it to a read-only record', () => {
    const store = withCrossTypeReopen(createEditorTabsStore())
    const logId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit',
      readOnly: true
    })
    parkRecoveredDraft(store, 'rescued draft')

    expect(store.getState().reopenClosedTab('wt-1')).toBe(true)

    // openFile reuses the read-only record, and its draft/dirty writes hard no-op — the snapshot
    // is the only copy of that text, so it goes back on the stack instead of being consumed.
    expect(store.getState().openFiles.map((f) => [f.id, f.readOnly === true, f.isDirty])).toEqual([
      [logId, true, false]
    ])
    expect(store.getState().editorDrafts).toEqual({})
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({ dirtyDraftContent: 'rescued draft' })
    ])
    expect(store.getState().recentlyClosedTabKindsByWorktree['wt-1']?.at(-1)).toBe('editor')
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
    expect(toastInfoMock).toHaveBeenCalledWith(
      'notes.md is open read-only. Close it, then reopen to recover the parked draft.'
    )
  })

  it('parks a recovered draft beside a read-only log without opening a second tab', () => {
    const store = createEditorTabsStore()
    const logId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit',
      readOnly: true
    })
    const firstGroupId = store.getState().groupsByWorktree['wt-1']?.[0]?.id ?? ''
    const secondGroupId = store
      .getState()
      .createEmptySplitGroup('wt-1', firstGroupId, 'right', { activate: false })
    expect(secondGroupId).toBeTruthy()
    parkRecoveredDraft(store, 'rescued draft')
    const parked = (store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? [])[0]
    store.setState({
      recentlyClosedEditorTabsByWorktree: {
        'wt-1': [{ ...parked, position: { groupId: secondGroupId ?? undefined } }]
      },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' }
    })

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    // The read-only record is reused by openFile whatever its identity key says, so the open must
    // not happen at all: a second tab in the snapshot's group would render the same log twice.
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(1)
    expect(store.getState().openFiles.map((f) => f.id)).toEqual([logId])
    expect(store.getState().activeFileId).toBe(logId)
    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([
      expect.objectContaining({ dirtyDraftContent: 'rescued draft' })
    ])
    expect(toastInfoMock).toHaveBeenCalledTimes(1)
  })

  it('consumes a recovered draft the reused alias record already holds', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    try {
      const store = createEditorStore()
      // Why the alias pair: only openFile's WSL-alias reuse lands a snapshot on a live record the
      // identity-keyed pre-open collision check cannot see.
      const liveId = store.getState().openFile({
        filePath: '//wsl.localhost/Ubuntu/home/Alice/repo/notes.md',
        relativePath: 'notes.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        mode: 'edit'
      })
      store.getState().setEditorDraft(liveId, 'same draft')
      store.getState().markFileDirty(liveId, true)
      store.getState().setLastKnownDiskSignature(liveId, 'sig-live')
      parkRecoveredDraft(store, 'same draft', {
        filePath: '\\\\wsl.localhost\\ubuntu\\home\\Alice\\repo\\notes.md',
        lastKnownDiskSignature: 'sig-draft'
      })

      expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

      expect(store.getState().openFiles).toHaveLength(1)
      expect(store.getState().editorDrafts[liveId]).toBe('same draft')
      expect(store.getState().openFiles[0]).toMatchObject({ lastKnownDiskSignature: 'sig-live' })
      expect(store.getState().openFiles[0].pendingDiskBaselineVerification).toBeUndefined()
      expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']).toEqual([])
      expect(toastInfoMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies the same recovered draft when the reused record is writable', () => {
    const store = withCrossTypeReopen(createEditorTabsStore())
    const liveId = openLocalEditor(store)
    parkRecoveredDraft(store, 'rescued draft')

    expect(store.getState().reopenClosedTab('wt-1')).toBe(true)

    expect(store.getState().editorDrafts[liveId]).toBe('rescued draft')
    expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1'] ?? []).toEqual([])
    expect(toastInfoMock).not.toHaveBeenCalled()
  })

  it('reopens close-all mirrored editor tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md')

    store.getState().closeAllFiles()

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles[0]).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('reopens replaced mirrored preview tabs as local tabs', () => {
    const store = createEditorStore()
    openMirroredEditor(store, '/repo/notes.md', true)

    store.getState().openFile(
      {
        filePath: '/repo/guide.md',
        relativePath: 'guide.md',
        worktreeId: 'wt-1',
        language: 'markdown',
        runtimeEnvironmentId: 'env-1',
        mode: 'edit'
      },
      { preview: true, recordReplacedPreview: true }
    )

    const recent = store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]
    expect(recent).toMatchObject({ filePath: '/repo/notes.md' })
    expect(recent).not.toHaveProperty('mirroredFromRuntimeSession')

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)
    expect(store.getState().openFiles.at(-1)).toMatchObject({ filePath: '/repo/notes.md' })
    expect(store.getState().openFiles.at(-1)).not.toHaveProperty('mirroredFromRuntimeSession')
  })

  it('restores the exact same-path owner instead of moving the local editor', () => {
    const store = createEditorTabsStore()
    const localId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const remoteId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      runtimeEnvironmentId: 'env-1',
      mode: 'edit'
    })
    store.getState().setTabBarOrder('wt-1', [localId, remoteId])

    store.getState().closeFile(remoteId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    const openIds = store.getState().openFiles.map((file) => file.id)
    expect(openIds).toEqual([localId, remoteId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([localId, remoteId])
  })

  it('keeps same-path edit and diff tabs as separate entities on reopen', () => {
    const store = createEditorTabsStore()
    const editId = store.getState().openFile({
      filePath: '/repo/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().openDiff('wt-1', '/repo/notes.md', 'notes.md', 'markdown', false)
    const diffId = 'wt-1::diff::unstaged::notes.md'
    store.getState().setTabBarOrder('wt-1', [editId, diffId])

    store.getState().closeFile(diffId)
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([editId, diffId])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([editId, diffId])
  })

  it('keeps close-all editor snapshots positioned for reopen', () => {
    const store = createEditorTabsStore()
    const firstId = store.getState().openFile({
      filePath: '/repo/first.md',
      relativePath: 'first.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const middleId = store.getState().openFile({
      filePath: '/repo/middle.md',
      relativePath: 'middle.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    const lastId = store.getState().openFile({
      filePath: '/repo/last.md',
      relativePath: 'last.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setTabBarOrder('wt-1', [firstId, middleId, lastId])

    store.getState().closeAllFiles()
    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles[0]?.id).toBe(firstId)
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([firstId])
  })

  it('captures close-all snapshot positions without rescanning tab state per closed tab', () => {
    const countEntityIdReads = (fileCount: number): number => {
      const store = createEditorTabsStore()
      for (let index = 0; index < fileCount; index += 1) {
        store.getState().openFile(
          {
            filePath: `/repo/file-${index}.ts`,
            relativePath: `file-${index}.ts`,
            worktreeId: 'wt-1',
            language: 'typescript',
            mode: 'edit'
          },
          { preview: false }
        )
      }
      let reads = 0
      store.setState({
        unifiedTabsByWorktree: {
          'wt-1': withCountedEntityIdReads(
            store.getState().unifiedTabsByWorktree['wt-1'] ?? [],
            () => {
              reads += 1
            }
          )
        }
      } as Partial<AppState>)
      reads = 0

      store.getState().closeAllFiles()

      expect(store.getState().openFiles).toHaveLength(0)
      expect(store.getState().recentlyClosedEditorTabsByWorktree['wt-1']?.[0]?.position).toEqual({
        tabBarIndex: 0,
        groupId: expect.any(String),
        groupIndex: 0
      })
      return reads
    }

    // Why: resolving each closed tab's position by rescanning tab order and group membership
    // made close-all cubic — 4x the tabs cost ~64x the scans and froze the renderer for seconds.
    expect(countEntityIdReads(80)).toBeLessThanOrEqual(countEntityIdReads(20) * 8)
  })

  it('reactivates the live tab when a stale reopen id targets an already-open file', () => {
    const store = createEditorTabsStore()
    store.setState({
      worktreesByRepo: {
        'repo-1': [
          { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
          { id: 'wt-2', repoId: 'repo-1', path: '/repo-2' }
        ]
      }
    } as unknown as Partial<AppState>)
    const sharedPath = '/home/me/.zshrc'
    const openShared = (worktreeId: string): string =>
      store.getState().openFile({
        filePath: sharedPath,
        relativePath: '.zshrc',
        worktreeId,
        language: 'shell',
        mode: 'edit'
      })

    // Bare path id: nothing else owns this path yet.
    const staleWt1Id = openShared('wt-1')
    expect(staleWt1Id).toBe(sharedPath)
    store.getState().closeFile(staleWt1Id)

    // wt-2 claims the bare id, so wt-1's reopen gets a namespaced id instead.
    const wt2Id = openShared('wt-2')
    expect(wt2Id).toBe(sharedPath)
    const liveWt1Id = openShared('wt-1')
    expect(liveWt1Id).toBe(ownedEditorFileId(sharedPath, 'wt-1', null))
    store.getState().closeFile(wt2Id)

    expect(store.getState().reopenClosedEditorTab('wt-1')).toBe(true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([liveWt1Id])
    expect(store.getState().activeFileId).toBe(liveWt1Id)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(liveWt1Id)
    expect(
      (store.getState().unifiedTabsByWorktree['wt-1'] ?? []).map((tab) => tab.entityId)
    ).toEqual([liveWt1Id])
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual([liveWt1Id])
  })
})
