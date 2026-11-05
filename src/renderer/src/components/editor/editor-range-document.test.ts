// @vitest-environment happy-dom

import { createHash } from 'node:crypto'

import { beforeEach, afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { openEditorRangeDocument } from './editor-range-document'
import {
  editorBytesDocument,
  loadEditorBytes,
  retainEditorBytes,
  releaseEditorBytes,
  setEditorBytesDraft
} from './save/bytes/editor-bytes-documents'

const originalApi = window.api
const file: OpenFile = {
  id: 'range-view',
  filePath: '/repo/data.bin',
  relativePath: 'data.bin',
  worktreeId: 'repo::/repo',
  runtimeEnvironmentId: null,
  language: 'plaintext',
  mode: 'edit',
  isDirty: false
}
const sibling: OpenFile = { ...file, id: 'source-view' }
const args = { target: { kind: 'local' as const }, filePath: file.filePath }
const descriptor = {
  id: 'saved-file',
  version: 1,
  byteLength: 2,
  maxReadBytes: 262144,
  readOnly: true as const,
  isBinary: true,
  valid: true
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    repos: [
      {
        id: 'repo',
        path: '/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      repo: [makeWorktree({ id: file.worktreeId, repoId: 'repo', path: '/repo', hostId: 'local' })]
    },
    openFiles: [file, sibling]
  })
})
afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, { api: originalApi })
})

it('refuses saved file ranges while an unmounted bytes editor retains a different draft', async () => {
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => {
          throw new Error('Dirty acquisition reached saved file A')
        }
      }
    }
  })
  loadEditorBytes(
    file.id,
    { bytes: new Uint8Array([0, 65]), fileType: 'bin' },
    createHash('sha256')
      .update(new Uint8Array([0, 65]))
      .digest('hex'),
    undefined
  )
  retainEditorBytes(file.id)
  setEditorBytesDraft(file.id, { bytes: new Uint8Array([0, 66]), fileType: 'bin' })
  releaseEditorBytes(file.id)
  await expect(openEditorRangeDocument(args, file.id, file)).rejects.toMatchObject({
    code: 'range_document_dirty'
  })
  expect([...editorBytesDocument(file.id)!.bytes]).toEqual([0, 66])
})

it('synchronously invalidates a pending saved-file read when a sibling becomes dirty and requires explicit reload after discard', async () => {
  const started = Promise.withResolvers<void>()
  const releaseRead = Promise.withResolvers<void>()
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => descriptor,
        rangeDocumentRead: async ({ version }: { version: number }) => {
          started.resolve()
          await releaseRead.promise
          return { version, contentBase64: 'AEE=', bytesRead: 2, eof: true }
        },
        rangeDocumentReload: async () => ({ ...descriptor, version: 2 }),
        rangeDocumentClose: async () => {},
        rangeDocumentCancel: async () => {}
      }
    }
  })
  const source = await openEditorRangeDocument(args, file.id, file)
  let invalidated = false
  source.onInvalidate(() => {
    invalidated = true
  })
  try {
    const pending = source.read({ version: 1, offset: 0, length: 2 })
    const rejected = expect(pending).rejects.toThrow('cancelled or invalidated')
    await started.promise
    useAppStore.getState().markFileDirty(sibling.id, true)
    expect(invalidated).toBe(true)
    await expect(source.reload()).rejects.toMatchObject({ code: 'range_document_dirty' })
    releaseRead.resolve()
    await rejected
    useAppStore.getState().markFileDirty(sibling.id, false)
    await expect(source.read({ version: 1, offset: 0, length: 2 })).rejects.toThrow(
      'Reload explicitly'
    )
    const next = await source.reload()
    const result = await source.read({ version: next.version, offset: 0, length: 2 })
    expect([...new Uint8Array(result.bytes)]).toEqual([0, 65])
  } finally {
    releaseRead.resolve()
    source.dispose()
  }
})

it('fences a pending reload across a dirty then clean transition and reopens only on the next explicit reload', async () => {
  const started = Promise.withResolvers<void>()
  const releaseReload = Promise.withResolvers<void>()
  const openIds = new Set<string>()
  let nextId = 0
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => {
          const id = `reload-${++nextId}`
          openIds.add(id)
          return { ...descriptor, id }
        },
        rangeDocumentReload: async ({ id }: { id: string }) => {
          if (!openIds.has(id)) throw new Error('Cannot reload closed owner')
          started.resolve()
          await releaseReload.promise
          return { ...descriptor, id, version: 2 }
        },
        rangeDocumentRead: async ({ id, version }: { id: string; version: number }) => {
          if (!openIds.has(id)) throw new Error('Cannot read closed owner')
          return { version, contentBase64: 'AEE=', bytesRead: 2, eof: true }
        },
        rangeDocumentClose: async ({ id }: { id: string }) => {
          openIds.delete(id)
        },
        rangeDocumentCancel: async () => {}
      }
    }
  })
  const source = await openEditorRangeDocument(args, file.id, file)
  try {
    const pending = source.reload()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await started.promise
    useAppStore.getState().markFileDirty(sibling.id, true)
    useAppStore.getState().markFileDirty(sibling.id, false)
    releaseReload.resolve()
    await rejected
    await expect(source.read({ version: 1, offset: 0, length: 2 })).rejects.toThrow(
      'Reload explicitly'
    )
    const next = await source.reload()
    const read = await source.read({ version: next.version, offset: 0, length: 2 })
    expect([...new Uint8Array(read.bytes)]).toEqual([0, 65])
  } finally {
    releaseReload.resolve()
    source.dispose()
  }
})
