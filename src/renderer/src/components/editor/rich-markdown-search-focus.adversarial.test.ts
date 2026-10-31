// @vitest-environment happy-dom
import { Editor, Node, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import {
  DragSelectionGuard,
  completeRichMarkdownSelection,
  richMarkdownSelectionCompletionEvents
} from './drag-selection-guard'
import { CellSelection } from '@tiptap/pm/tables'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { focusRichMarkdownEditorFromSearch } from './rich-markdown-search-focus'
import { createElement } from 'react'
import { fireEvent, render } from '@testing-library/react'
import { RichMarkdownToolbar } from './RichMarkdownToolbar'
import { installHappyDomSelectionNotificationTasks } from '../../../../../config/scripts/vitest-dom-setup'

function findTextPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Expected editor text: ${text}`)
  }
  return position
}

function createSurface(content: string, extensions: AnyExtension[] = []) {
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  document.body.append(root)
  const editor = new Editor({
    extensions: [StarterKit, TableKit, DragSelectionGuard, ...extensions],
    content,
    editorProps: {
      handleDOMEvents: {
        ...richMarkdownSelectionCompletionEvents,
        mousedown: (view, event) => {
          completeRichMarkdownSelection(view)
          focusRichMarkdownEditorFromSearch(event, view)
          return false
        }
      }
    }
  })
  root.append(editor.view.dom)
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const input = document.createElement('input')
  const replace = document.createElement('input')
  search.append(input, replace)
  root.append(search)
  return { editor, input, replace }
}

let disposeSelectionNotifications: (() => void) | null = null
beforeEach(() => {
  disposeSelectionNotifications = installHappyDomSelectionNotificationTasks(document)
})
afterEach(() => {
  disposeSelectionNotifications?.()
  disposeSelectionNotifications = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('Find focus with editor-owned selection', () => {
  it('bounds repeated input mapping to the owning document at N and 10N', async () => {
    vi.useFakeTimers()
    const samples: number[] = []
    for (const scale of [1, 10]) {
      const paragraphs = 20 * scale
      const surfaces = Array.from({ length: 3 * scale }, () =>
        createSurface('<p>lower caret</p>'.repeat(paragraphs))
      )
      const activeSurface = surfaces.at(-1)
      if (!activeSurface) {
        throw new Error('Expected active editor')
      }
      const active = activeSurface.editor
      const text = active.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected editor text')
      }
      active.view.focus()
      active.commands.setTextSelection(active.view.posAtDOM(text, 2))
      const reads = surfaces.map(() => 0)
      const publications = vi.fn()
      active.on('selectionUpdate', publications)
      const measuredViews = surfaces.map(({ editor }, owner) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Count real sibling reads on the pinned engine's root view description, without replacing its mapping logic.
        const view = editor.view as Editor['view'] & {
          docView: { children: unknown[] }
          domObserver: { flushSoon(): void }
        }
        const children = view.docView.children
        const descriptors: PropertyDescriptorMap = {}
        for (const key of Reflect.ownKeys(children)) {
          const descriptor = Object.getOwnPropertyDescriptor(children, key)
          if (!descriptor) {
            throw new Error('Expected root child property descriptor')
          }
          descriptors[key] = descriptor
        }
        children.forEach((child, index) => {
          Object.defineProperty(children, index, {
            configurable: true,
            get: () => {
              reads[owner]++
              return child
            }
          })
        })
        return {
          restore: () => Object.defineProperties(children, descriptors),
          flushSoon: () => view.domObserver.flushSoon()
        }
      })
      const filters = surfaces.map(({ editor }) => {
        const filter = vi.fn(() => true)
        editor.registerPlugin(new Plugin({ filterTransaction: filter }))
        return filter
      })
      const dispatches = surfaces.map(({ editor }) => vi.spyOn(editor.view, 'dispatch'))
      const constructors = vi.spyOn(TextSelection, 'between')
      const mappings = surfaces.map(({ editor }) => vi.spyOn(editor.view, 'posAtDOM'))
      const native = document.getSelection()
      if (!native) {
        throw new Error('Expected native selection')
      }
      const restorations = vi.spyOn(native, 'setBaseAndExtent')
      const nativeWrites = [
        vi.spyOn(native, 'collapse'),
        vi.spyOn(native, 'extend'),
        vi.spyOn(native, 'addRange'),
        vi.spyOn(native, 'removeAllRanges')
      ]
      const notifications = vi.fn()
      document.addEventListener('selectionchange', notifications)
      try {
        fireEvent.keyDown(active.view.dom, { key: 'Shift' })
        document.dispatchEvent(new Event('selectionchange'))
        vi.runAllTimers()
        expect(publications).not.toHaveBeenCalled()
        expect(restorations).not.toHaveBeenCalled()
        expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(reads.slice(0, -1)).toEqual(Array(surfaces.length - 1).fill(0))
        const activeReads = reads.at(-1)
        if (activeReads === undefined) {
          throw new Error('Expected active mapping count')
        }
        expect(activeReads).toBeGreaterThanOrEqual(paragraphs)
        expect(activeReads).toBeLessThanOrEqual(20 * paragraphs)
        samples.push(activeReads)

        for (const [step, boundary] of ['key', 'pending-flush', 'release'].entries()) {
          if (boundary === 'release') {
            vi.spyOn(active.view, 'posAtCoords').mockReturnValue({
              pos: active.state.selection.head,
              inside: -1
            })
            fireEvent.mouseDown(text.parentElement ?? active.view.dom, {
              button: 0,
              buttons: 1,
              shiftKey: true
            })
          }
          native.setBaseAndExtent(text, 7 + step, text, 2 + step)
          restorations.mockClear()
          nativeWrites.forEach((write) => write.mockClear())
          publications.mockClear()
          notifications.mockClear()
          reads.fill(0)
          if (boundary !== 'key') {
            const measuredActive = measuredViews.at(-1)
            if (!measuredActive) {
              throw new Error('Expected active observer')
            }
            measuredActive.flushSoon()
          }
          if (boundary === 'release') {
            fireEvent.mouseUp(document, { button: 0 })
          } else {
            fireEvent.keyDown(active.view.dom, { key: 'Control' })
          }
          expect(publications).toHaveBeenCalledOnce()
          expect(active.state.selection.anchor - active.state.selection.head).toBe(5)
          expect(notifications).not.toHaveBeenCalled()
          // Deliver completion's notification and settle engine work; it must not restore and notify again.
          document.dispatchEvent(new Event('selectionchange'))
          expect(notifications).toHaveBeenCalledOnce()
          vi.runAllTimers()
          expect(notifications).toHaveBeenCalledTimes(2)
          expect(publications).toHaveBeenCalledOnce()
          expect(restorations).toHaveBeenCalledTimes(1)
          expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
          expect(
            [restorations, ...nativeWrites].reduce(
              (total, write) => total + write.mock.calls.length,
              0
            )
          ).toBe(1)
          expect(reads.slice(0, -1)).toEqual(Array(surfaces.length - 1).fill(0))
          const settledReads = reads.at(-1)
          if (settledReads === undefined) {
            throw new Error('Expected settled owner mapping count')
          }
          expect(settledReads).toBeLessThanOrEqual(30 * paragraphs)
        }

        // Observation is a separate phase: genuine held motion maps/publishes/writes nothing.
        fireEvent.mouseDown(text.parentElement ?? active.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        native.setBaseAndExtent(text, 7, text, 2)
        restorations.mockClear()
        nativeWrites.forEach((write) => write.mockClear())
        publications.mockClear()
        reads.fill(0)
        constructors.mockClear()
        filters.forEach((filter) => filter.mockClear())
        dispatches.forEach((dispatch) => dispatch.mockClear())
        document.dispatchEvent(new Event('selectionchange'))
        expect(publications).not.toHaveBeenCalled()
        expect(restorations).not.toHaveBeenCalled()
        expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(reads).toEqual(Array(surfaces.length).fill(0))
        expect(constructors).not.toHaveBeenCalled()
        expect(filters.map((filter) => filter.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
        expect(dispatches.map((dispatch) => dispatch.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
        vi.advanceTimersByTime(400)
        activeSurface.input.focus()
        const accepted = active.state.selection
        active.view.dom.focus()
        const start = active.view.dom.querySelector('p')?.firstChild
        if (!start) {
          throw new Error('Expected focus reset text')
        }
        native.setBaseAndExtent(start, 0, start, 0)
        restorations.mockClear()
        nativeWrites.forEach((write) => write.mockClear())
        publications.mockClear()
        reads.fill(0)
        constructors.mockClear()
        filters.forEach((filter) => filter.mockClear())
        dispatches.forEach((dispatch) => dispatch.mockClear())
        document.dispatchEvent(new Event('selectionchange'))
        // Recovery has its own declared bound: exactly one model projection, zero publications.
        expect(restorations).toHaveBeenCalledOnce()
        expect(constructors).toHaveBeenCalledOnce()
        expect(publications).not.toHaveBeenCalled()
        expect(filters.map((filter) => filter.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
        expect(dispatches.map((dispatch) => dispatch.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
        expect(active.state.selection.eq(accepted)).toBe(true)
        vi.advanceTimersByTime(845)
        fireEvent.mouseUp(document, { button: 0 })
        vi.runAllTimers()
        expect(restorations).toHaveBeenCalledOnce()
        expect(publications).not.toHaveBeenCalled()
        expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(reads.slice(0, -1)).toEqual(Array(surfaces.length - 1).fill(0))
        expect(reads.at(-1)).toBeLessThanOrEqual(40 * paragraphs)
        expect(filters.map((filter) => filter.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
        expect(dispatches.map((dispatch) => dispatch.mock.calls.length)).toEqual(
          Array(surfaces.length).fill(0)
        )
      } finally {
        document.removeEventListener('selectionchange', notifications)
        measuredViews.forEach(({ restore }) => restore())
        surfaces.forEach(({ editor }) => editor.destroy())
        restorations.mockRestore()
        nativeWrites.forEach((write) => write.mockRestore())
      }
      await Promise.resolve()
      const counts = mappings.map((mapping) => mapping.mock.calls.length)
      document.dispatchEvent(new Event('selectionchange'))
      vi.runAllTimers()
      expect(mappings.map((mapping) => mapping.mock.calls.length)).toEqual(counts)
    }
    expect(samples[1]).toBeLessThanOrEqual(12 * samples[0])
  })

  it.each([
    { table: false, terminal: 'mouseup', anchor: 2, head: 7 },
    { table: true, terminal: 'mouseup', anchor: 7, head: 2 },
    { table: false, terminal: 'mousemove', anchor: 7, head: 2 }
  ])(
    'settles the real engine release writer ($terminal, table=$table)',
    ({ table, terminal, anchor, head }) => {
      vi.useFakeTimers()
      const { editor } = createSurface(
        table
          ? '<table><tbody><tr><td>lower caret</td><td>other cell</td></tr></tbody></table>'
          : '<p>lower caret</p>'
      )
      const text = editor.view.dom.querySelector('p')?.firstChild
      if (!text) {
        throw new Error('Expected native text')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inspect the pinned engine's actual tracker/observer; never replace its done or delayed writer.
      const engine = editor.view as Editor['view'] & {
        input: {
          mouseDown: { allowDefault: boolean; delayedSelectionSync: boolean; done(): void } | null
        }
        domObserver: { flushSoon(): void }
      }
      try {
        editor.view.focus()
        editor.commands.setTextSelection(editor.view.posAtDOM(text, 0))
        vi.runAllTimers()
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
          pos: editor.state.selection.from,
          inside: -1
        })
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        const tracker = engine.input.mouseDown
        if (!tracker) {
          throw new Error('Expected real native engine tracker')
        }
        expect(tracker.allowDefault).toBe(true)
        const done = vi.spyOn(tracker, 'done')
        const mappings = vi.spyOn(editor.view, 'posAtDOM')
        fireEvent.mouseMove(document, { buttons: 1 })
        expect(mappings).not.toHaveBeenCalled()
        const native = document.getSelection()
        if (!native) {
          throw new Error('Expected native selection')
        }
        native.setBaseAndExtent(text, anchor, text, head)
        document.dispatchEvent(new Event('selectionchange'))
        expect(editor.state.selection.empty).toBe(true)
        engine.domObserver.flushSoon()
        const publications = vi.fn()
        editor.on('selectionUpdate', publications)
        const restore = vi.spyOn(native, 'setBaseAndExtent')
        const writes = [
          vi.spyOn(native, 'collapse'),
          vi.spyOn(native, 'extend'),
          vi.spyOn(native, 'addRange'),
          vi.spyOn(native, 'removeAllRanges')
        ]
        document.dispatchEvent(new MouseEvent(terminal, { button: 0, buttons: 0, bubbles: true }))
        expect(done).toHaveBeenCalledOnce()
        expect(engine.input.mouseDown).toBeNull()
        expect(tracker.delayedSelectionSync).toBe(true)
        expect(publications).toHaveBeenCalledOnce()
        expect(restore).toHaveBeenCalledOnce()
        expect(editor.state.selection.anchor).toBe(editor.view.posAtDOM(text, anchor))
        expect(editor.state.selection.head).toBe(editor.view.posAtDOM(text, head))
        // Equivalent text endpoints allow one restoration; immediate and delayed engine writers must do nothing.
        document.dispatchEvent(new Event('selectionchange'))
        vi.runAllTimers()
        expect(writes.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(
          [restore, ...writes].reduce((total, write) => total + write.mock.calls.length, 0)
        ).toBe(1)
        expect(restore).toHaveBeenCalledOnce()
        expect(publications).toHaveBeenCalledOnce()
        expect(native.anchorNode).toBe(text)
        expect(native.focusNode).toBe(text)
        expect(native.anchorOffset).toBe(anchor)
        expect(native.focusOffset).toBe(head)
        // Teardown with a fresh real delayed engine writer still outstanding.
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          clientX: 1000,
          clientY: 1000,
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        const teardownTracker = engine.input.mouseDown
        if (!teardownTracker) {
          throw new Error('Expected teardown gesture tracker')
        }
        native.setBaseAndExtent(text, head, text, anchor)
        document.dispatchEvent(new Event('selectionchange'))
        restore.mockClear()
        writes.forEach((write) => write.mockClear())
        fireEvent.mouseUp(document, { button: 0 })
        expect(teardownTracker.delayedSelectionSync).toBe(true)
        editor.destroy()
        document.dispatchEvent(new MouseEvent('mouseup', { button: 0 }))
        document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }))
        vi.runAllTimers()
        expect(writes.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(restore).toHaveBeenCalledOnce()
        expect(
          [restore, ...writes].reduce((total, write) => total + write.mock.calls.length, 0)
        ).toBe(1)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['find', 'replace', 'control', 'return-before-release'] as const)(
    'does not import another focus owner’s editor-contained fallback on release (%s)',
    (owner) => {
      vi.useFakeTimers()
      const controlNode = Node.create({
        name: 'releaseControl',
        group: 'block',
        atom: true,
        parseHTML: () => [{ tag: 'section' }],
        renderHTML: () => ['section'],
        addNodeView: () => () => {
          const dom = document.createElement('section')
          const input = document.createElement('input')
          dom.append(input)
          return { dom, stopEvent: () => true }
        }
      })
      const { editor, input, replace } = createSurface('<p>lower caret</p><section></section>', [
        controlNode
      ])
      const text = editor.view.dom.querySelector('p')?.firstChild
      const control = editor.view.dom.querySelector('section input')
      if (!text || !(control instanceof HTMLInputElement)) {
        throw new Error('Expected text and stopped control')
      }
      try {
        editor.view.focus()
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
        fireEvent.mouseDown(text.parentElement ?? editor.view.dom, {
          button: 0,
          buttons: 1,
          shiftKey: true
        })
        document.getSelection()?.setBaseAndExtent(text, 2, text, 7)
        document.dispatchEvent(new Event('selectionchange'))
        const destination = owner === 'control' ? control : owner === 'replace' ? replace : input
        destination.focus()
        expect(editor.state.selection.from).toBe(3)
        expect(editor.state.selection.to).toBe(8)
        if (owner === 'control') {
          fireEvent.mouseDown(control, { button: 0 })
        }
        editor.commands.setTextSelection({ from: 9, to: 12 })
        document.getSelection()?.setBaseAndExtent(text, 0, text, 1)
        document.dispatchEvent(new Event('selectionchange'))
        const mappings = vi.spyOn(editor.view, 'posAtDOM')
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Observe the pinned engine flush boundary without replacing it.
        const engine = editor.view as Editor['view'] & { domObserver: { forceFlush(): void } }
        const flushes = vi.spyOn(engine.domObserver, 'forceFlush')
        if (owner === 'return-before-release') {
          editor.view.focus()
        }
        fireEvent.mouseUp(document, { button: 0 })
        if (owner !== 'return-before-release') {
          expect(mappings).not.toHaveBeenCalled()
          expect(flushes).not.toHaveBeenCalled()
        }
        vi.runAllTimers()
        expect(editor.state.selection.from).toBe(9)
        expect(editor.state.selection.to).toBe(12)
        editor.view.focus()
        editor.commands.insertContent('new')
        vi.runAllTimers()
        expect(editor.view.dom.querySelector('p')?.textContent).toBe('lower canew')
      } finally {
        editor.destroy()
      }
    }
  )

  it('formats the deliberate model selection while Find owns focus', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface('<p>first</p><p>lower caret</p>')
    const toolbar = render(
      createElement(RichMarkdownToolbar, {
        editor,
        onToggleLink: vi.fn(),
        onImagePick: vi.fn()
      })
    )
    try {
      editor.view.focus()
      const text = editor.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected editor text')
      }
      document.getSelection()?.setBaseAndExtent(text, 2, text, 7)
      input.focus()
      // Explicit Find navigation changes the model while the input owns the native selection.
      editor.commands.setTextSelection({ from: 1, to: 6 })
      const bold = toolbar.getByRole('button', { name: 'Bold' })
      fireEvent.mouseDown(bold, { button: 0 })
      fireEvent.click(bold)
      expect(editor.view.dom.querySelector('strong')?.textContent).toBe('first')
      expect(editor.view.dom.querySelector('p:last-child')?.textContent).toBe('lower caret')
    } finally {
      toolbar.unmount()
      editor.destroy()
    }
  })

  it.each(['find', 'replace'] as const)(
    'publishes undelivered native selections before %s takes focus and before immediate copy',
    (field) => {
      const { editor, input, replace } = createSurface('<p>first</p><p>lower caret</p>')
      const text = editor.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected lower paragraph text')
      }
      const lower = findTextPosition(editor, 'lower caret')
      try {
        editor.view.focus()
        const updates = vi.fn()
        editor.on('update', updates)
        const doc = editor.state.doc
        for (const [anchor, head] of [
          [2, 7],
          [7, 2],
          [6, 6]
        ]) {
          document.getSelection()?.setBaseAndExtent(text, anchor, text, head)
          // No selectionchange is delivered before the direct focus transfer.
          ;(field === 'find' ? input : replace).focus()
          expect(editor.state.selection.anchor).toBe(lower + anchor)
          expect(editor.state.selection.head).toBe(lower + head)
          editor.view.focus()
          expect(document.getSelection()?.anchorOffset).toBe(anchor)
          expect(document.getSelection()?.focusOffset).toBe(head)
        }
        document.getSelection()?.setBaseAndExtent(text, 7, text, 2)
        editor.view.dom.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }))
        expect(editor.state.selection.anchor).toBe(lower + 7)
        expect(editor.state.selection.head).toBe(lower + 2)
        expect(editor.state.doc).toBe(doc)
        expect(updates).not.toHaveBeenCalled()
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['find', 'replace'] as const)(
    'restores the anchor before editor pointer handling from %s',
    (field) => {
      vi.useFakeTimers()
      const { editor, input, replace } = createSurface('<p>first</p><p>lower caret</p>')
      const caret = findTextPosition(editor, 'lower caret') + 6
      const updates = vi.fn()
      editor.on('update', updates)
      try {
        editor.commands.setTextSelection(caret)
        ;(field === 'find' ? input : replace).focus()
        document.getSelection()?.removeAllRanges()
        const paragraph = editor.view.dom.querySelector('p:last-child')
        const text = paragraph?.firstChild
        if (!paragraph || !text) {
          throw new Error('Expected lower paragraph text')
        }
        vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: caret, inside: -1 })
        const beforePointer = vi.fn(() => ({
          focused: document.activeElement === editor.view.dom,
          anchor: document.getSelection()?.anchorNode,
          offset: document.getSelection()?.anchorOffset
        }))
        editor.registerPlugin(
          new Plugin({
            props: {
              handleDOMEvents: {
                mousedown: () => {
                  beforePointer()
                  return false
                }
              }
            }
          })
        )
        const originalDoc = editor.state.doc
        const selection = editor.state.selection
        const event = new MouseEvent('mousedown', {
          button: 0,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })

        paragraph.dispatchEvent(event)

        expect(beforePointer).toHaveReturnedWith({ focused: true, anchor: text, offset: 6 })
        expect(document.activeElement).toBe(editor.view.dom)
        expect(document.getSelection()?.anchorNode).toBe(text)
        expect(document.getSelection()?.anchorOffset).toBe(6)
        expect(document.getSelection()?.focusOffset).toBe(6)
        expect(event.defaultPrevented).toBe(false)

        vi.advanceTimersByTime(20)

        expect(editor.state.selection).toBe(selection)
        expect(editor.state.doc).toBe(originalDoc)
        expect(updates).not.toHaveBeenCalled()
      } finally {
        editor.destroy()
      }
    }
  )

  it('focuses a handled cross-cell selection and preserves its cells without marking content dirty', () => {
    vi.useFakeTimers()
    const { editor, input } = createSurface(
      '<table><tbody><tr><td>first</td><td>second</td></tr></tbody></table>'
    )
    const updates = vi.fn()
    try {
      editor.commands.setTextSelection(findTextPosition(editor, 'first'))
      editor.on('update', updates)
      input.focus()
      const secondPos = findTextPosition(editor, 'second')
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: secondPos, inside: secondPos })
      const second = editor.view.dom.querySelector('td:last-child p')
      if (!second) {
        throw new Error('Expected second table cell')
      }
      const originalDoc = editor.state.doc
      const event = new MouseEvent('mousedown', {
        button: 0,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })

      second.dispatchEvent(event)

      const selection = editor.state.selection
      expect(selection).toBeInstanceOf(CellSelection)
      expect(selection).toEqual(
        CellSelection.create(
          editor.state.doc,
          findTextPosition(editor, 'first') - 2,
          findTextPosition(editor, 'second') - 2
        )
      )
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(editor.view.dom)
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
      expect(editor.view.dom.classList.contains('ProseMirror-hideselection')).toBe(true)
      expect(document.getSelection()?.rangeCount).toBe(1)

      vi.advanceTimersByTime(20)

      expect(editor.state.selection).toBe(selection)
      expect(editor.state.doc).toBe(originalDoc)
      expect(updates).not.toHaveBeenCalled()
      expect(editor.view.dom.querySelectorAll('.selectedCell')).toHaveLength(2)
    } finally {
      editor.destroy()
    }
  })
  it('leaves a NodeView that stops pointer events in charge of focus', () => {
    const root = document.createElement('div')
    root.className = 'rich-markdown-editor-shell'
    const search = document.createElement('div')
    search.className = 'rich-markdown-search'
    const input = document.createElement('input')
    search.append(input)
    document.body.append(root)
    const handoff = vi.fn(focusRichMarkdownEditorFromSearch)
    const editor = new Editor({
      extensions: [
        StarterKit,
        Node.create({
          name: 'pointerControl',
          group: 'block',
          atom: true,
          parseHTML: () => [{ tag: 'section' }],
          renderHTML: () => ['section'],
          addNodeView: () => () => ({
            dom: document.createElement('section'),
            stopEvent: () => true
          })
        })
      ],
      content: '<section></section>',
      editorProps: {
        handleDOMEvents: {
          mousedown: (view, event) => {
            handoff(event, view)
            return false
          }
        }
      }
    })
    root.append(editor.view.dom, search)
    try {
      input.focus()
      editor.view.dom
        .querySelector('section')
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      expect(handoff).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(input)
    } finally {
      editor.destroy()
    }
  })
})
