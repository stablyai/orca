// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import { CellSelection } from '@tiptap/pm/tables'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'

vi.mock('@/runtime/runtime-file-client', () => ({ importExternalPathsToRuntime: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      settings: null,
      folderWorkspaces: [],
      worktreesByRepo: {},
      openFiles: []
    }))
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: vi.fn((settings) => settings)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

type ImportResult = Awaited<ReturnType<typeof importExternalPathsToRuntime>>
const editors: Editor[] = []
const SOURCE = [
  'Before table',
  '| Left | Right | Keep |\n| --- | --- | --- |\n| one | two | keep top |\n| three | four | keep bottom |\n| outside one | outside two | outside keep |',
  'After table'
].join('\n\n')
const SELECTED = ['one', 'two', 'three', 'four']

function richEditor(reversed = false): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: SOURCE,
    contentType: 'markdown'
  })
  editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  editors.push(editor)
  const first = cellPosition(editor, 'one')
  const last = cellPosition(editor, 'four')
  editor.view.dispatch(
    editor.state.tr.setSelection(
      CellSelection.create(editor.state.doc, reversed ? last : first, reversed ? first : last)
    )
  )
  expect(editor.state.selection.ranges).toHaveLength(4)
  return editor
}

function cellPosition(editor: Editor, text: string): number {
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' && node.textContent === text) {
      position = pos
    }
  })
  if (position === undefined) {
    throw new Error(`Table cell missing: ${text}`)
  }
  return position
}

function table(editor: Editor) {
  const node = Array.from({ length: editor.state.doc.childCount }, (_, index) =>
    editor.state.doc.child(index)
  ).find((node) => node.type.name === 'table')
  if (!node) {
    throw new Error('Table missing')
  }
  return node
}

function expectReplacedCells(editor: Editor, reversed = false, keepTop = 'keep top') {
  const node = table(editor)
  const rows: string[][] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(cell.textContent))
    rows.push(cells)
  })
  expect(rows).toEqual([
    ['Left', 'Right', 'Keep'],
    ['', '', keepTop],
    ['', '', 'keep bottom'],
    ['outside one', 'outside two', 'outside keep']
  ])
  const images: string[] = []
  const headCell = node.child(reversed ? 1 : 2).child(reversed ? 0 : 1)
  headCell.descendants((child) => {
    if (child.type.name === 'image') {
      images.push(child.attrs.src)
    }
  })
  expect(images).toEqual(['image.png'])
  expect(editor.view.dom.querySelectorAll('img')).toHaveLength(1)
  editor.state.doc.check()
}

function pendingPaste(editor: Editor) {
  let resolve: (result: ImportResult) => void = () => {}
  vi.mocked(importExternalPathsToRuntime).mockReturnValue(
    new Promise<ImportResult>((complete) => {
      resolve = complete
    })
  )
  const clipboardData = new DataTransfer()
  clipboardData.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  const event = new ClipboardEvent('paste', { clipboardData, cancelable: true })
  expect(
    handleRichMarkdownImagePaste({ editor, event, filePath: '/repo/note.md', worktreeId: null })
  ).toBe(true)
  expect(event.defaultPrevented).toBe(true)
  return () =>
    resolve({
      results: [
        {
          sourcePath: '/tmp/image.png',
          status: 'imported',
          destPath: '/repo/image.png',
          kind: 'file',
          renamed: false
        }
      ]
    })
}

async function flushPromises() {
  for (let index = 0; index < 16; index++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/image.png') } }
  })
})

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('async image paste over table cells', () => {
  it.each([false, true])(
    'replaces every selected cell and supports undo, reversed=%s',
    async (reversed) => {
      const editor = richEditor(reversed)
      const before = editor.getJSON()
      const complete = pendingPaste(editor)
      await flushPromises()
      complete()
      await flushPromises()
      expectReplacedCells(editor, reversed)
      expect(editor.state.doc.firstChild?.textContent).toBe('Before table')
      expect(editor.state.doc.lastChild?.textContent).toBe('After table')
      expect(editor.commands.undo()).toBe(true)
      expect(editor.getJSON()).toEqual(before)
      editor.state.doc.check()
    }
  )

  it('maps the complete cell selection through an edit before the table', async () => {
    const editor = richEditor()
    const complete = pendingPaste(editor)
    await flushPromises()
    editor.view.dispatch(editor.state.tr.insertText('prefix ', 1))
    complete()
    await flushPromises()
    expectReplacedCells(editor)
    expect(editor.state.doc.firstChild?.textContent).toBe('prefix Before table')
    expect(editor.state.doc.lastChild?.textContent).toBe('After table')
  })

  it('does not absorb a new row inserted between the originally selected rows', async () => {
    const editor = richEditor()
    const complete = pendingPaste(editor)
    await flushPromises()
    const { tableRow, tableCell, paragraph } = editor.schema.nodes
    const insertedRow = tableRow.create(
      null,
      ['new left', 'new right', 'new keep'].map((text) =>
        tableCell.create(null, paragraph.create(null, editor.schema.text(text)))
      )
    )
    editor.view.dispatch(editor.state.tr.insert(cellPosition(editor, 'three') - 1, insertedRow))
    const afterEdit = editor.getJSON()
    complete()
    await flushPromises()
    expect(editor.getJSON()).toEqual(afterEdit)
    expect(editor.view.dom.querySelectorAll('img')).toHaveLength(0)
    editor.state.doc.check()
  })

  it('preserves text entered in an unselected column while replacing the original cells', async () => {
    const editor = richEditor()
    const complete = pendingPaste(editor)
    await flushPromises()
    editor.view.dispatch(
      editor.state.tr.insertText('updated ', cellPosition(editor, 'keep top') + 2)
    )
    complete()
    await flushPromises()
    expectReplacedCells(editor, false, 'updated keep top')
  })

  it.each(SELECTED)('cancels when %s is edited even if it is not the head cell', async (text) => {
    const editor = richEditor()
    const complete = pendingPaste(editor)
    await flushPromises()
    editor.view.dispatch(editor.state.tr.insertText('changed ', cellPosition(editor, text) + 2))
    const afterEdit = editor.getJSON()
    complete()
    await flushPromises()
    expect(editor.getJSON()).toEqual(afterEdit)
    expect(editor.view.dom.querySelectorAll('img')).toHaveLength(0)
    editor.state.doc.check()
  })

  it('keeps the live caret in another paragraph after replacing the table cells', async () => {
    const editor = richEditor()
    const complete = pendingPaste(editor)
    await flushPromises()
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertContent('x')
    complete()
    await flushPromises()
    expectReplacedCells(editor)
    editor.commands.insertContent('y')
    expect(editor.state.doc.lastChild?.textContent).toBe('After tablexy')
    expect(editor.state.selection.empty).toBe(true)
    editor.state.doc.check()
  })
})
