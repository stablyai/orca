// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(value\d)\}\}/g, (_match, name: string) => values?.[name] ?? '')
}))

const readRuntimeFileBytes = vi.fn()
vi.mock('@/runtime/runtime-paged-file-read', () => ({
  readRuntimeFileBytes: (...args: unknown[]) => readRuntimeFileBytes(...args)
}))

const store = vi.hoisted(() => ({
  markFileDirty: vi.fn(),
  openFiles: [{ id: 'book', isDirty: false }],
  editorBufferIdOf: {},
  editorBufferViews: {},
  listeners: new Set<(state: unknown, previous: unknown) => void>()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: (listener: (state: unknown) => void) => {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    },
    getState: () => store
  }
}))
vi.mock('./ExternalFileChangeBanner', () => ({
  ExternalFileChangeBanner: () => <div data-testid="banner" />
}))

const frameProps = vi.fn()
vi.mock('./PluginCustomEditorFrame', () => ({
  default: (props: Record<string, unknown>) => {
    frameProps(props)
    return <div data-testid="frame" />
  }
}))

import PluginBytesCustomEditorSurface from './PluginBytesCustomEditorSurface'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const editor: ActivePluginCustomEditor = {
  id: 'sheet',
  title: 'Spreadsheet',
  extensions: ['.xlsx', '.xls'],
  filenames: [],
  priority: 'default',
  contentKind: 'bytes',
  key: 'stablyai.spreadsheet/sheet',
  pluginKey: 'stablyai.spreadsheet',
  pluginName: 'Spreadsheet Viewer'
}
const byteSource = { target: { kind: 'local' as const }, filePath: '/repo/book.xlsx' }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  readRuntimeFileBytes.mockReset()
  frameProps.mockReset()
})

afterEach(async () => {
  // Closing the tab drops its bytes document.
  for (const listener of store.listeners) {
    listener({ openFiles: [] }, store)
  }
  await act(async () => root.unmount())
  container.remove()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the surface reads only these fields.
const file = { id: 'book', filePath: '/repo/book.xlsx', readOnly: false } as OpenFile
const onSave = vi.fn(async () => true)

async function render(fileContent: FileContent): Promise<void> {
  await act(async () => {
    root.render(
      <PluginBytesCustomEditorSurface
        editor={editor}
        file={file}
        fileContent={fileContent}
        onSave={onSave}
        reloadContent={() => {}}
      />
    )
  })
}

function lastDocument(): unknown {
  return frameProps.mock.calls.at(-1)?.[0].binaryDocument
}

describe('PluginBytesCustomEditorSurface', () => {
  it('mounts the frame at once and hands it the bytes read on the same route, capped at 64 MiB', async () => {
    const bytes = new Uint8Array([0x50, 0x4b])
    readRuntimeFileBytes.mockResolvedValue({ kind: 'ok', bytes })
    await render({ content: '', isBinary: true, byteSource })
    expect(readRuntimeFileBytes).toHaveBeenCalledWith(byteSource, 64 * 1024 * 1024)
    expect(frameProps.mock.calls[0][0]).toMatchObject({
      readOnly: false,
      fileId: 'book',
      binaryDocument: null
    })
    // The load hashes the bytes asynchronously before handing them over.
    await act(() => vi.waitFor(() => expect(lastDocument()).toEqual({ bytes, fileType: 'xlsx' })))
  })

  it('names the file, its size and the limit when it is too large to open', async () => {
    readRuntimeFileBytes.mockResolvedValue({ kind: 'too_large', size: 80 * 1024 * 1024 })
    await render({ content: '', isBinary: true, byteSource })
    expect(container.textContent).toContain(
      'book.xlsx is too large to open in Spreadsheet (80.0 MB; the limit is 64.0 MB).'
    )
    expect(container.querySelector('[data-testid="frame"]')).toBeNull()
  })

  it('reloads after an outside change but not while the old content is only marked stale', async () => {
    readRuntimeFileBytes.mockResolvedValue({ kind: 'ok', bytes: new Uint8Array([1]) })
    const first: FileContent = { content: '', isBinary: true, byteSource }
    await render(first)
    await render({ ...first, isStale: true })
    expect(readRuntimeFileBytes).toHaveBeenCalledTimes(1)
    const reloaded = new Uint8Array([2])
    readRuntimeFileBytes.mockResolvedValue({ kind: 'ok', bytes: reloaded })
    await render({ content: '', isBinary: true, byteSource })
    expect(readRuntimeFileBytes).toHaveBeenCalledTimes(2)
    await act(() =>
      vi.waitFor(() => expect(lastDocument()).toEqual({ bytes: reloaded, fileType: 'xlsx' }))
    )
  })

  it('keeps an edit as the dirty draft across a remount and never rereads under it', async () => {
    readRuntimeFileBytes.mockResolvedValue({ kind: 'ok', bytes: new Uint8Array([1]) })
    await render({ content: '', isBinary: true, byteSource })
    await act(() => vi.waitFor(() => expect(lastDocument()).not.toBeNull()))
    const edited = { bytes: new Uint8Array([9, 9]), fileType: 'xlsx' }
    await act(async () => frameProps.mock.calls.at(-1)?.[0].onBytesChange(edited))
    expect(store.markFileDirty).toHaveBeenCalledWith('book', true)
    expect(lastDocument()).toBe(edited)
    await act(async () => root.unmount())
    root = createRoot(container)
    await render({ content: '', isBinary: true, byteSource })
    expect(readRuntimeFileBytes).toHaveBeenCalledTimes(1)
    expect(lastDocument()).toBe(edited)
    expect(frameProps.mock.calls.at(-1)?.[0].onSave).toBe(onSave)
  })
})
