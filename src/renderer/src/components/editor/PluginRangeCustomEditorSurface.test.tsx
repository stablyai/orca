// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useCustomEditorViewStore,
  type ActivePluginCustomEditor
} from '@/store/plugin-custom-editors'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'
import {
  openEditorRangeDocument,
  openEditorRangeSource,
  readEditorRangeFileContent
} from './editor-range-document'
import type { RuntimeRangeDocument } from '@/runtime/runtime-range-document'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import PluginBytesCustomEditorSurface from './PluginBytesCustomEditorSurface'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'

vi.mock('./PluginCustomEditorFrame', () => ({
  default: ({ rangeDocument }: { rangeDocument: RuntimeRangeDocument }) => (
    <output data-testid="range-frame">{rangeDocument.value().byteLength}</output>
  )
}))
vi.mock('../wsl-host-stopped/use-stopped-wsl-host', () => ({ useStoppedWslHost: () => null }))

const originalApi = window.api
const file: OpenFile = {
  id: 'file',
  filePath: '/repo/data.bin',
  relativePath: 'data.bin',
  worktreeId: '',
  language: 'plaintext',
  mode: 'edit',
  isDirty: true
}
const byteSource = { target: { kind: 'local' as const }, filePath: file.filePath }
const editor: ActivePluginCustomEditor = {
  id: 'bytes',
  title: 'Bytes',
  key: 'test.range/bytes',
  pluginKey: 'test.range',
  pluginName: 'Range',
  extensions: ['.bin'],
  filenames: [],
  priority: 'default',
  contentKind: 'bytes',
  documentAccess: 'ranges'
}
const content: FileContent = { content: '', isBinary: true, byteSource }

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ openFiles: [file] })
  useCustomEditorViewStore.setState({ choices: { file: editor.key } })
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => ({
          id: 'saved',
          version: 1,
          byteLength: 2,
          maxReadBytes: 262144,
          readOnly: true,
          isBinary: true,
          valid: true
        }),
        rangeDocumentClose: async () => {}
      }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, { api: originalApi })
})

it('recovers a mounted ranges surface when discard and panel Reload provide a new document', async () => {
  const view = render(
    <PluginBytesCustomEditorSurface
      editor={editor}
      file={file}
      fileContent={content}
      onSave={async () => false}
      reloadContent={() => {}}
    />
  )
  await view.findByRole('button', { name: 'Source' })
  expect(view.queryByTestId('range-frame')).toBeNull()
  let source: RuntimeRangeDocument | undefined
  try {
    await act(async () => {
      useAppStore.getState().markFileDirty(file.id, false)
      const clean = useAppStore.getState().openFiles[0]
      source = await openEditorRangeDocument(byteSource, file.id, clean)
      view.rerender(
        <PluginBytesCustomEditorSurface
          editor={editor}
          file={clean}
          fileContent={{ ...content, rangeDocument: source }}
          onSave={async () => false}
          reloadContent={() => {}}
        />
      )
    })
    expect(view.getByTestId('range-frame').textContent).toBe('2')
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull()
  } finally {
    source?.dispose()
  }
})

it('leaves an optional range failure through an explicit Source choice before reading Source', async () => {
  useAppStore.getState().markFileDirty(file.id, false)
  window.api.fs.rangeDocumentOpen = async () => {
    throw new RuntimeRpcCallError({
      id: 'open-range',
      ok: false,
      error: { code: 'range_document_unsupported', message: '' }
    })
  }
  let pending: Promise<FileContent> | undefined
  let observedChoice: string | undefined
  const reloadContent = () => {
    observedChoice = useCustomEditorViewStore.getState().choices[file.id]
    pending = readEditorRangeFileContent({
      args: byteSource,
      fileId: file.id,
      file,
      isCurrent: () => true,
      readSource: async () => ({ content: 'saved Source', isBinary: false })
    })
  }
  const view = render(
    <PluginBytesCustomEditorSurface
      editor={editor}
      file={file}
      fileContent={content}
      onSave={async () => false}
      reloadContent={reloadContent}
    />
  )
  const source = await view.findByRole('button', { name: 'Source' })
  expect(pending).toBeUndefined()
  await act(async () => {
    fireEvent.click(source)
    await pending
  })
  expect(observedChoice).toBe('source')
  await expect(pending).resolves.toMatchObject({ content: 'saved Source', isBinary: false })
})

it('offers Source on a selected range load error without claiming an editor is ready', () => {
  let observedChoice: string | undefined
  const view = render(
    <EditorFileLoadErrorView
      message="Ranged documents require a newer host"
      onRetry={() => {}}
      onOpenSource={() =>
        openEditorRangeSource(file, () => {
          observedChoice = useCustomEditorViewStore.getState().choices[file.id]
        })
      }
    />
  )
  expect(observedChoice).toBeUndefined()
  fireEvent.click(view.getByRole('button', { name: 'Source' }))
  expect(observedChoice).toBe('source')
})
