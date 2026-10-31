// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { TextSelection, Plugin } from '@tiptap/pm/state'
import { CellSelection, tableEditingKey } from '@tiptap/pm/tables'
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

function surface(integrated = true) {
  const host = document.createElement('div')
  document.body.append(host)
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, TableKit, ...(integrated ? [DragSelectionGuard] : [])],
    content:
      '<h1>Heading stays</h1><p>lower target</p>' +
      '<table><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td><td>delta</td></tr></table>',
    editorProps: { handleDOMEvents: integrated ? richMarkdownSelectionCompletionEvents : {} }
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
  ['text', 'notification']
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
      editor.state.tr
        .setSelection(CellSelection.create(editor.state.doc, first, last))
        .setMeta(tableEditingKey, first)
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Use the actual inherited suppression seam while the actual tracker owns held input.
  const observer = editor.view as Editor['view'] & {
    domObserver: { suppressSelectionUpdates(): void }
  }
  observer.domObserver.suppressSelectionUpdates()
  selectNative(text, 12, 6)
  document.dispatchEvent(new Event('selectionchange'))
  expect(editor.state.selection.empty).toBe(true)
  expect(document.getSelection()?.anchorNode).toBe(text)
  expect(document.getSelection()?.anchorOffset).toBe(12)
  expect(document.getSelection()?.focusOffset).toBe(6)
  vi.advanceTimersByTime(50)
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

it.each(['publication', 'registration'] as const)(
  'keeps navigation by a new focus owner during pending DOM %s',
  (boundary) => {
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
    if (boundary === 'publication') {
      editor.on('update', navigate)
      text.nodeValue = 'new target'
      selectNative(text, 4, 10)
    } else {
      const outgoing = document.createElement('input')
      document.body.append(outgoing)
      outgoing.focus()
      let handoff = true
      editor.view.setProps({
        nodeViews: {
          paragraph: () => {
            const dom = document.createElement('p')
            return {
              dom,
              contentDOM: dom,
              ignoreMutation: (mutation) => {
                if (mutation.type !== 'selection' && handoff) {
                  handoff = false
                  navigate()
                }
                return mutation.type !== 'selection'
              }
            }
          }
        }
      })
      const current = textNode(editor, 'p')
      selectNative(current, 6, 12)
      current.parentElement?.setAttribute('data-pending', 'owned')
      // Exercise the actual outgoing engine entry with A owning focus during registration.
      editor.view.completeNativeSelection(true)
      expect(handoff).toBe(false)
    }
    expect(copy(editor)).toBe('Heading')
    expect(document.activeElement).toBe(input)
    vi.runAllTimers()
    expect(editor.state.selection.from).toBe(1)
    expect(editor.state.selection.to).toBe(8)
  }
)

function heldRange(editor: Editor, text: Node) {
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
    pos: editor.view.posAtDOM(text, 0),
    inside: -1
  })
  fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
    button: 0,
    buttons: 1,
    shiftKey: true
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Read the pinned engine's real tracker; never replace its lifetime or delayed writer.
  const engine = editor.view as Editor['view'] & {
    input: {
      mouseDown: { allowDefault: boolean; delayedSelectionSync: boolean; done(): void } | null
    }
  }
  const tracker = engine.input.mouseDown
  if (!tracker) {
    throw new Error('Expected real held gesture')
  }
  expect(tracker.allowDefault).toBe(true)
  selectNative(text, 12, 6)
  document.dispatchEvent(new Event('selectionchange'))
  expect(editor.state.selection.empty).toBe(true)
  // Preserve the engine's real recent-click exclusion; this is not a widened classifier window.
  vi.advanceTimersByTime(400)
  return { engine, tracker }
}

it.each(['notification', 'copy', 'beforeinput', 'no-buttons'] as const)(
  'classifies held bare-return presentation before %s and all late writers',
  (boundary) => {
    const editor = surface()
    const text = textNode(editor, 'p')
    const { engine, tracker } = heldRange(editor, text)
    const publications = vi.fn()
    editor.on('selectionUpdate', publications)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    const accepted = editor.state.selection
    expect(accepted.anchor).toBe(editor.view.posAtDOM(text, 12))
    expect(accepted.head).toBe(editor.view.posAtDOM(text, 6))
    expect(engine.input.mouseDown).toBe(tracker)
    expect(tracker.delayedSelectionSync).toBe(true)
    expect(publications).toHaveBeenCalledOnce()
    editor.view.dom.focus()
    // Declared synthetic Chromium reset after real core focus; not a physical-native reproduction.
    selectNative(textNode(editor, 'h1'), 0, 0)
    if (boundary === 'notification' || boundary === 'no-buttons') {
      document.dispatchEvent(new Event('selectionchange'))
    } else if (boundary === 'copy') {
      expect(copy(editor)).toBe('target')
    } else {
      fireEvent(
        editor.view.dom,
        new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'x' })
      )
    }
    expect(editor.state.selection.eq(accepted)).toBe(true)
    expect(document.getSelection()?.anchorNode).toBe(text)
    expect(document.getSelection()?.anchorOffset).toBe(12)
    expect(document.getSelection()?.focusOffset).toBe(6)
    vi.advanceTimersByTime(845)
    expect(copy(editor)).toBe('target')
    fireEvent(
      document,
      new MouseEvent(boundary === 'no-buttons' ? 'mousemove' : 'mouseup', {
        bubbles: true,
        button: 0,
        buttons: 0
      })
    )
    expect(engine.input.mouseDown).toBeNull()
    vi.runAllTimers()
    expect(publications).toHaveBeenCalledOnce()
    expect(editor.state.selection.eq(accepted)).toBe(true)
    editor.commands.insertContent('x')
    expect(editor.view.dom.querySelector('p')?.textContent).toBe('lower x')
    expect(editor.view.dom.querySelector('h1')?.textContent).toBe('Heading stays')
  }
)

it('observes incoming focus before synchronous custom redirect and preserves newer navigation', () => {
  const editor = surface()
  const text = textNode(editor, 'p')
  heldRange(editor, text)
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const accepted = editor.state.selection
  const observations: number[] = []
  editor.view.setProps({
    handleDOMEvents: {
      ...richMarkdownSelectionCompletionEvents,
      focus: (view) => {
        observations.push(document.getSelection()?.focusOffset ?? -1)
        expect(view.state.selection.eq(accepted)).toBe(true)
        input.focus()
        editor.commands.setTextSelection({ from: 1, to: 8 })
        return false
      }
    }
  })
  // A reset already present at core focus must be classified before the custom callback reads it.
  selectNative(textNode(editor, 'h1'), 0, 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Schedule the pinned engine's actual inherited observer work, without replacing it.
  const scheduled = editor.view as Editor['view'] & { domObserver: { flushSoon(): void } }
  scheduled.domObserver.flushSoon()
  editor.view.dom.focus()
  expect(observations).toEqual([6])
  expect(document.activeElement).toBe(input)
  expect(editor.view.dom.classList.contains('ProseMirror-focused')).toBe(false)
  expect(editor.state.selection.from).toBe(1)
  expect(editor.state.selection.to).toBe(8)
  vi.runAllTimers()
  expect(editor.state.selection.from).toBe(1)
  expect(editor.state.selection.to).toBe(8)
})

it('preserves the core and table owners when held input resumes after a focus roundtrip', () => {
  const editor = surface()
  const paragraphs = editor.view.dom.querySelectorAll('td p')
  const first = paragraphs[0]?.firstChild
  const second = paragraphs[1]?.firstChild
  if (!first || !second) {
    throw new Error('Expected table text')
  }
  editor.commands.setTextSelection(editor.view.posAtDOM(first, 1))
  vi.spyOn(editor.view, 'posAtCoords').mockImplementation((coords) => ({
    pos: editor.view.posAtDOM(coords.left === 10 ? second : first, 1),
    inside: -1
  }))
  fireEvent.mouseDown(first.parentElement ?? editor.view.dom, {
    button: 0,
    buttons: 1,
    shiftKey: true
  })
  selectNative(first, 1, 4)
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(400)
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const accepted = editor.state.selection
  editor.view.dom.focus()
  selectNative(textNode(editor, 'h1'), 0, 0)
  document.dispatchEvent(new Event('selectionchange'))
  const updates = vi.fn()
  editor.on('selectionUpdate', updates)
  // Deliver a real table move into another cell while the original core tracker is still held.
  const dispatch = vi.spyOn(editor.view, 'dispatch')
  fireEvent.mouseMove(second.parentElement ?? editor.view.dom, { buttons: 1, clientX: 10 })
  expect(dispatch.mock.calls.some(([tr]) => tr.selection instanceof CellSelection)).toBe(true)
  expect(editor.state.selection).not.toBeInstanceOf(CellSelection)
  expect(editor.state.selection.eq(accepted)).toBe(true)
  selectNative(first, 2, 5)
  document.dispatchEvent(new Event('selectionchange'))
  expect(updates).not.toHaveBeenCalled()
  fireEvent.mouseUp(document, { button: 0 })
  expect(editor.state.selection.from).toBe(editor.view.posAtDOM(first, 2))
  expect(editor.state.selection.to).toBe(editor.view.posAtDOM(first, 5))
  vi.runAllTimers()
  expect(updates).toHaveBeenCalledOnce()
})

it('retains unopted engine custom-focus order and ordinary native acceptance', () => {
  const editor = surface(false)
  const coreFocus = vi.fn()
  editor.view.setProps({
    handleDOMEvents: {
      focus: (view) => {
        coreFocus(view.dom.classList.contains('ProseMirror-focused'))
        return false
      }
    }
  })
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  editor.view.dom.focus()
  expect(coreFocus).toHaveBeenCalledWith(false)
  vi.advanceTimersByTime(400)
  const text = textNode(editor, 'p')
  selectNative(text, 6, 12)
  document.dispatchEvent(new Event('selectionchange'))
  expect(editor.state.selection.from).toBe(editor.view.posAtDOM(text, 6))
  expect(editor.state.selection.to).toBe(editor.view.posAtDOM(text, 12))
})

it.each([true, false])(
  'retains actual suppression projection and later genuine input (opted=%s)',
  (integrated) => {
    const editor = surface(integrated)
    const text = textNode(editor, 'p')
    const from = editor.view.posAtDOM(text, 6)
    editor.commands.setTextSelection({ from, to: from + 6 })
    vi.runAllTimers()
    const accepted = editor.state.selection
    const publication = vi.fn()
    editor.on('selectionUpdate', publication)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Exercise the pinned observer's inherited suppression policy, not a replacement flag/timer.
    const engine = editor.view as Editor['view'] & {
      domObserver: { suppressSelectionUpdates(): void }
    }
    engine.domObserver.suppressSelectionUpdates()
    selectNative(textNode(editor, 'h1'), 0, 7)
    document.dispatchEvent(new Event('selectionchange'))
    expect(editor.state.selection.eq(accepted)).toBe(true)
    expect(document.getSelection()?.anchorNode).toBe(text)
    expect(document.getSelection()?.anchorOffset).toBe(6)
    expect(document.getSelection()?.focusOffset).toBe(12)
    expect(publication).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    selectNative(text, 0, 5)
    document.dispatchEvent(new Event('selectionchange'))
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
    ).toBe('lower')
    expect(publication).toHaveBeenCalledOnce()
  }
)

it('projects current navigation when a real NodeView changes the accepted model during recovery', () => {
  const editor = surface()
  let navigate = false
  const projections = vi.fn()
  editor.view.setProps({
    nodeViews: {
      paragraph: () => {
        const dom = document.createElement('p')
        return {
          dom,
          contentDOM: dom,
          setSelection: (anchor, head) => {
            projections()
            if (navigate) {
              navigate = false
              editor.commands.setTextSelection({ from: 1, to: 8 })
              return
            }
            const text = dom.firstChild
            if (!text) {
              throw new Error('Expected NodeView text')
            }
            selectNative(text, anchor, head)
          }
        }
      }
    }
  })
  const text = textNode(editor, 'p')
  heldRange(editor, text)
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  editor.view.dom.focus()
  selectNative(textNode(editor, 'h1'), 0, 0)
  navigate = true
  projections.mockClear()
  document.dispatchEvent(new Event('selectionchange'))
  expect(projections).toHaveBeenCalledOnce()
  expect(copy(editor)).toBe('Heading')
  expect(editor.state.selection.from).toBe(1)
  expect(editor.state.selection.to).toBe(8)
  fireEvent.mouseUp(document, { button: 0 })
  vi.runAllTimers()
  expect(editor.state.selection.from).toBe(1)
  expect(editor.state.selection.to).toBe(8)
})
