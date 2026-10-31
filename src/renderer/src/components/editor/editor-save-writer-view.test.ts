import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { editorSaveWriterView } from './editor-save-writer-view'

const STALE: EditorFileOperationProvenance = {
  ownershipProjection: 'explicit',
  generation: {
    route: { executionHostId: 'local', runtimeEnvironmentId: null },
    runtimeConnectionGeneration: null,
    runtimePairingRevision: undefined,
    runtimeSshGeneration: null,
    nestedSshGeneration: null,
    directSshGeneration: null
  }
}

vi.mock('@/lib/editor-file-operation-owner', () => ({
  captureEditorFileOperationForOwner: (
    _state: unknown,
    _file: OpenFile,
    provenance: EditorFileOperationProvenance
  ) => {
    if (provenance === STALE) {
      throw new Error('Reopen the file')
    }
  }
}))

function view(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: true,
    mode: 'edit',
    ...patch
  }
}

/** Use the real shared-record shape with old representing a pre-reconnect view. */
function sharedState(views: OpenFile[]): AppState {
  const ids = views.map((file) => file.id)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial state; the writer view reads only open files and the view index.
  return {
    openFiles: views,
    editorBufferIdOf: Object.fromEntries(ids.map((id) => [id, 'rec'])),
    editorBufferViews: { rec: ids }
  } as unknown as AppState
}

describe('editorSaveWriterView', () => {
  const old = view('old', { operationProvenance: STALE })
  const fresh = view('fresh')

  it('autosave skips a view whose owner is stale', () => {
    expect(editorSaveWriterView(sharedState([old, fresh]), 'old', 'autosave')?.id).toBe('fresh')
  })

  it('autosave skips a read-only view', () => {
    const readOnly = view('ro', { readOnly: true })
    expect(editorSaveWriterView(sharedState([readOnly, fresh]), 'ro', 'autosave')?.id).toBe('fresh')
  })

  it.each(['autosave', 'restart'] as const)(
    '%s skips a CSV preview or read-only view listed first',
    (trigger) => {
      const csv = view('csv', { csvPreviewOnly: true })
      const readOnly = view('ro', { readOnly: true })
      expect(editorSaveWriterView(sharedState([csv, readOnly, fresh]), 'csv', trigger)?.id).toBe(
        'fresh'
      )
    }
  )

  it('autosave has no writer when every view is stale', () => {
    expect(editorSaveWriterView(sharedState([old]), 'old', 'autosave')).toBeNull()
  })

  it('an explicit save writes through the view that asked', () => {
    expect(editorSaveWriterView(sharedState([old, fresh]), 'old', 'user')?.id).toBe('old')
    expect(editorSaveWriterView(sharedState([old, fresh]), 'old', 'overwrite')?.id).toBe('old')
  })

  it('restart falls back to the asking view so its owner error surfaces', () => {
    expect(editorSaveWriterView(sharedState([old]), 'old', 'restart')?.id).toBe('old')
  })
})
