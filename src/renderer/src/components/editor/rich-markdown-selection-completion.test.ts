// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { TextSelection, Plugin } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { DragSelectionGuard, richMarkdownSelectionCompletionEvents } from './drag-selection-guard'
import { installHappyDomSelectionNotificationTasks } from '../../../../../config/scripts/vitest-dom-setup'

const editors: Editor[] = []
let disposeNotifications: (() => void) | null = null
beforeEach(() => {
  vi.useFakeTimers()
  disposeNotifications = installHappyDomSelectionNotificationTasks(document)
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  disposeNotifications?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function surface() {
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, TableKit, DragSelectionGuard],
    content:
      '<h1>Heading stays</h1><p>lower target</p>' +
      '<table><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></table>',
    editorProps: { handleDOMEvents: richMarkdownSelectionCompletionEvents }
  })
  editors.push(editor)
  editor.view.focus()
  vi.advanceTimersByTime(300)
  return editor
}

function textNode(editor: Editor, selector: string): Node {
  const node = editor.view.dom.querySelector(selector)?.firstChild
  if (!node) {
    throw new Error('Expected editor text')
  }
  return node
}

function selectNative(node: Node, anchor: number, head: number): void {
  const native = document.getSelection()
  if (!native) {
    throw new Error('Expected native selection')
  }
  native.setBaseAndExtent(node, anchor, node, head)
}

function copy(editor: Editor): string {
  const data = new DataTransfer()
  fireEvent(
    editor.view.dom,
    new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data })
  )
  return data.getData('text/plain')
}

it.each([
  ['cells', 'notification'],
  ['cells', 'copy'],
  ['text', 'notification'],
  ['text', 'copy']
] as const)('keeps the accepted %s target on bare focus return before %s', (kind, boundary) => {
  const editor = surface()
  if (kind === 'cells') {
    const cells: number[] = []
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') {
        cells.push(position)
      }
    })
    const first = cells[0]
    const last = cells.at(-1)
    if (first === undefined || last === undefined) {
      throw new Error('Expected table cells')
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last))
    )
  } else {
    const text = textNode(editor, 'p')
    const from = editor.view.posAtDOM(text, 6)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from + 6, from))
    )
  }
  const accepted = editor.state.selection
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  // Reproduce the observed native return prefix, without the model-restoring view.focus().
  editor.view.dom.focus()
  selectNative(textNode(editor, 'h1'), 0, 0)
  expect(editor.state.selection.eq(accepted)).toBe(true)
  if (boundary === 'notification') {
    document.dispatchEvent(new Event('selectionchange'))
  }
  const copied = copy(editor)
  expect(editor.state.selection.eq(accepted)).toBe(true)
  if (kind === 'cells') {
    expect(copied).toContain('alpha')
    expect(copied).toContain('delta')
  } else {
    expect(copied).toBe('target')
    editor.commands.insertContent('x')
    expect(editor.view.dom.querySelector('p')?.textContent).toBe('lower x')
  }
  vi.runAllTimers()
  expect(editor.view.dom.querySelector('h1')?.textContent).toBe('Heading stays')
})

it('copies genuine cache-equal held input after the engine tracker has finished', () => {
  const editor = surface()
  const text = textNode(editor, 'p')
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
  fireEvent.mouseDown(editor.view.dom, { button: 0, buttons: 1, shiftKey: true })
  selectNative(text, 12, 6)
  document.dispatchEvent(new Event('selectionchange'))
  expect(editor.state.selection.empty).toBe(true)
  const input: unknown = 'input' in editor.view ? editor.view.input : undefined
  if (!input || typeof input !== 'object' || !('mouseDown' in input)) {
    throw new Error('Expected real engine input')
  }
  const tracker = input.mouseDown
  if (
    !tracker ||
    typeof tracker !== 'object' ||
    !('done' in tracker) ||
    typeof tracker.done !== 'function'
  ) {
    throw new Error('Expected real engine tracker')
  }
  tracker.done()
  expect(copy(editor)).toBe('target')
  expect(editor.state.selection.anchor).toBe(editor.view.posAtDOM(text, 12))
  expect(editor.state.selection.head).toBe(editor.view.posAtDOM(text, 6))
})

it.each([false, true])(
  'consumes undelivered DOM work in the current document/configuration (reconfigure=%s)',
  (reconfigure) => {
    const editor = surface()
    const text = textNode(editor, 'p')
    if (reconfigure) {
      const replace = () => {
        editor.off('update', replace)
        editor.commands.setContent('<h1>Heading stays</h1><p>replacement target</p>')
        editor.registerPlugin(new Plugin({}))
        const current = textNode(editor, 'p')
        const from = editor.view.posAtDOM(current, 12)
        editor.commands.setTextSelection({ from, to: from + 6 })
      }
      editor.on('update', replace)
    }
    text.nodeValue = 'new target'
    selectNative(text, 4, 10)
    expect(editor.getText()).toContain('lower target')
    expect(copy(editor)).toBe('target')
    expect(editor.view.dom.querySelector('p')?.textContent).toBe(
      reconfigure ? 'replacement target' : 'new target'
    )
    const selection = editor.state.selection
    document.dispatchEvent(new Event('selectionchange'))
    vi.runAllTimers()
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(editor.view.dom.querySelector('h1')?.textContent).toBe('Heading stays')
  }
)

it('keeps navigation by a new focus owner during pending DOM publication', () => {
  const editor = surface()
  const text = textNode(editor, 'p')
  const input = document.createElement('input')
  document.body.append(input)
  const navigate = () => {
    editor.off('update', navigate)
    input.focus()
    editor.commands.setTextSelection({ from: 1, to: 8 })
    selectNative(textNode(editor, 'p'), 4, 10)
  }
  editor.on('update', navigate)
  text.nodeValue = 'new target'
  selectNative(text, 4, 10)
  expect(copy(editor)).toBe('Heading')
  expect(document.activeElement).toBe(input)
  vi.runAllTimers()
  expect(editor.state.selection.from).toBe(1)
  expect(editor.state.selection.to).toBe(8)
})
