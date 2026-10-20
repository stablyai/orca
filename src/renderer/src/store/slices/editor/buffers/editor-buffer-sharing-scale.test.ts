import { expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import type { EditorBufferIdentity } from './editor-buffer-identity'
import { EMPTY_EDITOR_BUFFER_INDEX } from './editor-buffer-record'
import { reconcileEditorBufferSharing } from './editor-buffer-sharing'

const TABS = 2000

function identityOf(file: OpenFile): EditorBufferIdentity {
  // Half the files are open in two workspaces, so lookups hit real same-file records.
  return {
    key: JSON.stringify([null, 'local', file.filePath]),
    environmentId: null,
    revision: undefined,
    modelOwnerKey: ''
  }
}

it(`reconciles ${TABS} tabs in one update without quadratic work`, () => {
  const openFiles: OpenFile[] = Array.from({ length: TABS }, (_, index) => ({
    id: `tab-${index}`,
    filePath: `/repo/file-${index % (TABS / 2)}.ts`,
    relativePath: `file-${index % (TABS / 2)}.ts`,
    worktreeId: index < TABS / 2 ? 'wt-1' : 'wt-2',
    language: 'typescript',
    isDirty: false,
    mode: 'edit'
  }))
  const base = {
    drafts: {},
    previousRecords: {},
    previousFiles: null,
    identityOf,
    onMirrorDrift: () => {},
    draftPreference: () => 0,
    now: () => 0
  }

  const firstStart = performance.now()
  const first = reconcileEditorBufferSharing({
    ...base,
    openFiles,
    records: {},
    index: EMPTY_EDITOR_BUFFER_INDEX
  })
  const firstMs = performance.now() - firstStart
  expect(Object.keys(first.records)).toHaveLength(TABS / 2)

  // One tab's identity is re-checked, as after a mirror write; every record is scanned for rejoin.
  const touched = openFiles.map((file, index) => (index === 0 ? { ...file } : file))
  const updateStart = performance.now()
  reconcileEditorBufferSharing({
    ...base,
    openFiles: touched,
    records: first.records,
    index: first.index,
    previousRecords: first.records,
    previousFiles: new Map(openFiles.map((file) => [file.id, file]))
  })
  const updateMs = performance.now() - updateStart

  expect(updateMs).toBeLessThan(50)
  expect(firstMs).toBeLessThan(200)
})
