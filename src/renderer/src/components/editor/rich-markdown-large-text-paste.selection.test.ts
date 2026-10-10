// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { CellSelection } from '@tiptap/pm/tables'
import { AllSelection, Plugin, TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const editors: Editor[] = []
const largeText = 'X'.repeat(70 * 1024)

function createEditor(
  content = '<p>hello world</p><p>second paragraph</p>',
  extensions: Extension[] = []
) {
  const editor = new Editor({ extensions: [StarterKit, TableKit, ...extensions], content })
  document.body.append(editor.view.dom)
  editor.view.dom.focus()
  if (editor.state.doc.firstChild?.isTextblock) {
    editor.commands.setTextSelection({ from: 7, to: 12 })
  }
  editors.push(editor)
  return editor
}

function pasteEvent(text = largeText): ClipboardEvent {
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  return new ClipboardEvent('paste', { clipboardData, cancelable: true })
}

function pause() {
  let resume: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    resume = resolve
  })
  return { promise, resume: () => resume() }
}

async function flush() {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve()
  }
}

function textPosition(editor: Editor, text: string): number {
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos
    }
  })
  if (position === undefined) {
    throw new Error(`Missing text ${text}`)
  }
  return position
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('large Markdown paste selection during yields', () => {
  it('replaces the original selection while preserving a caret moved during production-size measurement', async () => {
    const editor = createEditor()
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    expect(handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })).toBe(true)
    expect(yieldToEventLoop).toHaveBeenCalledOnce()
    editor.commands.setTextSelection(14)
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent === `hello ${largeText}`).toBe(true)
    expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
    expect(document.activeElement).toBe(editor.view.dom)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps every remaining production-size chunk at its insertion end after the caret moves', async () => {
    const editor = createEditor()
    const delay = pause()
    const yieldToEventLoop = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(delay.promise)
      .mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    await flush()
    expect(editor.state.doc.child(0).textContent.length).toBe(6 + 16 * 1024)
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent === `hello ${largeText}`).toBe(true)
    expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  })

  it('maps the original selection through an earlier edit and its appended transaction', async () => {
    const appendPrefix = Extension.create({
      name: 'pasteAppendPrefix',
      addProseMirrorPlugins: () => [
        new Plugin({
          appendTransaction(transactions, _old, state) {
            return transactions.some((tr) => tr.getMeta('appendPastePrefix'))
              ? state.tr.insertText('next ', 1)
              : null
          }
        })
      ]
    })
    const editor = createEditor(undefined, [appendPrefix])
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    editor.view.dispatch(editor.state.tr.insertText('first ', 1).setMeta('appendPastePrefix', true))
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent === `next first hello ${largeText}`).toBe(true)
    expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
  })

  it.each(['replace', 'delete', 'insert'] as const)(
    'cancels when %s changes the pending selected text',
    async (operation) => {
      const editor = createEditor()
      const delay = pause()
      const yieldToEventLoop = vi
        .fn()
        .mockReturnValueOnce(delay.promise)
        .mockResolvedValue(undefined)
      const off = vi.spyOn(editor, 'off')
      handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
      const tr = editor.state.tr
      if (operation === 'replace') {
        tr.insertText('changed', 7, 12)
      }
      if (operation === 'delete') {
        tr.delete(7, 12)
      }
      if (operation === 'insert') {
        tr.insertText('typed', 9)
      }
      editor.view.dispatch(tr)
      const changed = editor.getJSON()
      delay.resume()
      await flush()
      expect(editor.getJSON()).toEqual(changed)
      expect(off.mock.calls.map(([event]) => event)).toContain('transaction')
      expect(off.mock.calls.map(([event]) => event)).toContain('destroy')
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        'Large paste cancelled because its original target changed.'
      )
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it.each(['file', 'host'] as const)(
    'cancels when the original %s context changes',
    async (change) => {
      const editor = createEditor()
      const context = { filePath: '/repo/note.md' }
      setRichMarkdownImageResolverContext(editor, context)
      const delay = pause()
      const yieldToEventLoop = vi
        .fn()
        .mockReturnValueOnce(delay.promise)
        .mockResolvedValue(undefined)
      handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
      setRichMarkdownImageResolverContext(
        editor,
        change === 'file'
          ? { filePath: '/repo/other.md' }
          : {
              ...context,
              runtimeContext: {
                connectionId: 'another-target',
                target: { kind: 'local' as const },
                worktreeId: 'workspace',
                worktreePath: '/repo'
              }
            }
      )
      delay.resume()
      await flush()
      expect(editor.state.doc.child(0).textContent).toBe('hello world')
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        'Large paste cancelled because its original target changed.'
      )
      expect(toast.error).not.toHaveBeenCalled()
    }
  )

  it('uses native multi-cell replacement before continuing in the first inserted cell', async () => {
    const content =
      '<table><tbody><tr><td>first</td><td>second</td></tr><tr><td>third</td><td>fourth</td></tr></tbody></table><p>outside</p>'
    const editor = createEditor(content)
    const cellPositions: number[] = []
    editor.state.doc.descendants((node, position) => {
      if (node.type.spec.tableRole === 'cell') {
        cellPositions.push(position)
      }
    })
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, cellPositions[0]!, cellPositions[3]!)
      )
    )
    const original = editor.state.doc
    const native = editor.state.tr.insertText(largeText).doc
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    const outside = textPosition(editor, 'outside')
    editor.commands.setTextSelection(outside + 2)
    delay.resume()
    await flush()
    expect(editor.state.doc.eq(native)).toBe(true)
    expect(editor.state.doc.child(0).childCount).toBe(original.child(0).childCount)
    expect(editor.state.selection.from).toBe(textPosition(editor, 'outside') + 2)
  })

  it('releases successful paste listeners and undoes all chunks together', async () => {
    const editor = createEditor()
    const original = editor.getJSON()
    const off = vi.spyOn(editor, 'off')
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop: async () => {} })
    await flush()
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(original)
    expect(off.mock.calls.map(([event]) => event)).toContain('transaction')
    expect(off.mock.calls.map(([event]) => event)).toContain('destroy')
  })
  it('keeps the pending paste before ordinary typing at its original collapsed caret', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection(7)
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    editor.commands.insertContent('typed ')
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent === `hello ${largeText}typed world`).toBe(true)
    expect(editor.state.selection.from).toBe(7 + largeText.length + 'typed '.length)
  })

  it('excludes later typing at both ends of a reversed pending selection', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection({ from: 12, to: 7 })
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    editor.view.dispatch(editor.state.tr.insertText('start ', 7))
    editor.view.dispatch(editor.state.tr.insertText(' end', 18))
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent === `hello start ${largeText} end`).toBe(true)
  })

  it('cancels when a new table row would expand the captured cell rectangle', async () => {
    const editor = createEditor(
      '<table><tbody><tr><td>first</td><td>second</td></tr><tr><td>third</td><td>fourth</td></tr></tbody></table>'
    )
    const positions: number[] = []
    editor.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === 'cell') {
        positions.push(pos)
      }
    })
    editor.view.dispatch(
      editor.state.tr.setSelection(
        CellSelection.create(editor.state.doc, positions[0]!, positions[3]!)
      )
    )
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    const row = editor.schema.nodeFromJSON({
      type: 'tableRow',
      content: [
        { type: 'tableCell', content: [{ type: 'paragraph' }] },
        { type: 'tableCell', content: [{ type: 'paragraph' }] }
      ]
    })
    editor.view.dispatch(
      editor.state.tr.insert(1 + editor.state.doc.child(0).child(0).nodeSize, row)
    )
    const changed = editor.state.doc
    delay.resume()
    await flush()
    expect(editor.state.doc.eq(changed)).toBe(true)
  })

  it('groups slow chunks as one undo step, separate from earlier and later typing', async () => {
    const editor = createEditor()
    const initial = editor.state.doc
    editor.commands.insertContent('before')
    const beforePaste = editor.state.doc
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      yieldToEventLoop: async () => {
        now += 1000
      }
    })
    await flush()
    const pasted = editor.state.doc
    editor.commands.insertContent('after')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(pasted)).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(beforePaste)).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(initial)).toBe(true)
  })

  it('cancels remaining chunks when the user undoes the first chunk', async () => {
    const editor = createEditor()
    const initial = editor.state.doc
    const delay = pause()
    const yieldToEventLoop = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(delay.promise)
      .mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop })
    await flush()
    expect(editor.commands.undo()).toBe(true)
    delay.resume()
    await flush()
    expect(editor.state.doc.eq(initial)).toBe(true)
  })

  it('stops and releases listeners when the first paste transaction is filtered', async () => {
    const rejectPaste = Extension.create({
      name: 'rejectLargePaste',
      addProseMirrorPlugins: () => [new Plugin({ filterTransaction: (tr) => !tr.docChanged })]
    })
    const editor = createEditor(undefined, [rejectPaste])
    const initial = editor.state.doc
    const off = vi.spyOn(editor, 'off')
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop: async () => {} })
    await flush()
    expect(editor.state.doc.eq(initial)).toBe(true)
    expect(off.mock.calls.map(([event]) => event)).toEqual(['transaction', 'destroy'])
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      'Large paste cancelled because its original target changed.'
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'disconnected', 'destroyed'] as const)(
    'cancels and releases listeners when the target is %s during measurement',
    async (condition) => {
      const editor = createEditor()
      const initial = editor.state.doc
      const delay = pause()
      const off = vi.spyOn(editor, 'off')
      handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
        yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
      })
      if (condition === 'disabled') {
        editor.setEditable(false)
      }
      if (condition === 'disconnected') {
        editor.view.dom.remove()
      }
      if (condition === 'destroyed') {
        editor.destroy()
      }
      delay.resume()
      await flush()
      if (!editor.isDestroyed) {
        expect(editor.state.doc.eq(initial)).toBe(true)
      }
      expect(off.mock.calls.map(([event]) => event)).toContain('transaction')
      expect(off.mock.calls.map(([event]) => event)).toContain('destroy')
      expect(toast.info).toHaveBeenCalledExactlyOnceWith(
        'Large paste cancelled because its original target changed.'
      )
      expect(toast.error).not.toHaveBeenCalled()
    }
  )
  it('preserves marks armed at the original collapsed paste caret', async () => {
    const editor = createEditor()
    editor.commands.setTextSelection(7)
    editor.commands.toggleBold()
    expect(editor.state.storedMarks?.some((mark) => mark.type.name === 'bold')).toBe(true)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), { yieldToEventLoop: async () => {} })
    await flush()
    let pastedMarks: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.isText && node.text?.includes('X')) {
        pastedMarks = node.marks.map((mark) => mark.type.name)
      }
    })
    expect(pastedMarks).toEqual(['bold'])
  })

  it('preserves armed marks at a moved live caret while writing the captured range', async () => {
    const editor = createEditor()
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    editor.commands.setTextSelection(14)
    editor.commands.toggleItalic()
    delay.resume()
    await flush()
    expect(editor.state.storedMarks?.some((mark) => mark.type.name === 'italic')).toBe(true)
    expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  })
  it.each(['adjacent', 'other paragraph'] as const)(
    'keeps typing at %s separate between chronological paste segments',
    async (position) => {
      const editor = createEditor()
      const initial = editor.state.doc
      const delay = pause()
      const yieldToEventLoop = vi
        .fn()
        .mockReturnValueOnce(delay.promise)
        .mockResolvedValue(undefined)
      handleRichMarkdownLargeTextPaste(editor, pasteEvent('ABCDE'), {
        directMaxBytes: 1,
        chunkMaxBytes: 2,
        yieldToEventLoop
      })
      await flush()
      expect(editor.state.doc.child(0).textContent).toBe('hello AB')
      if (position === 'other paragraph') {
        editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
      }
      editor.commands.insertContent('T')
      const typed = editor.state.doc
      delay.resume()
      await flush()
      expect(editor.state.doc.child(0).textContent).toBe(
        position === 'adjacent' ? 'hello ABCDET' : 'hello ABCDE'
      )
      expect(editor.state.doc.child(1).textContent).toBe(
        position === 'adjacent' ? 'second paragraph' : 'Tsecond paragraph'
      )
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.eq(typed)).toBe(true)
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.child(0).textContent).toBe('hello AB')
      expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
      expect(editor.commands.undo()).toBe(true)
      expect(editor.state.doc.eq(initial)).toBe(true)
    }
  )

  it('closes partial paste history after focus cancellation without reclaiming focus', async () => {
    const editor = createEditor()
    const initialPlugins = editor.state.plugins
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('ABCDE'), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      yieldToEventLoop
    })
    await flush()
    expect(editor.state.doc.child(0).textContent).toBe('hello AB')
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    delay.resume()
    await flush()
    expect(document.activeElement).toBe(input)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith('Large paste stopped before it finished.')
    expect(toast.error).not.toHaveBeenCalled()
    expect(editor.state.plugins).toEqual(initialPlugins)
    editor.view.dom.focus()
    editor.commands.insertContent('T')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.child(0).textContent).toBe('hello AB')
  })

  it('cancels a full-document selection when a new paragraph appears outside its original range', async () => {
    const editor = createEditor()
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    const initialPlugins = editor.state.plugins
    const delay = pause()
    const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('ABCDE'), {
      directMaxBytes: 1,
      measureYieldAfterCodeUnits: 1,
      yieldToEventLoop
    })
    const paragraph = editor.schema.nodeFromJSON({
      type: 'paragraph',
      content: [{ type: 'text', text: 'new outside' }]
    })
    editor.view.dispatch(editor.state.tr.insert(0, paragraph))
    const changed = editor.state.doc
    delay.resume()
    await flush()
    expect(editor.state.doc.eq(changed)).toBe(true)
    expect(editor.state.plugins).toEqual(initialPlugins)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      'Large paste cancelled because its original target changed.'
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps an appended-only external edit separate from both paste segments in undo', async () => {
    const appendTyping = Extension.create({
      name: 'appendExternalTyping',
      addProseMirrorPlugins: () => [
        new Plugin({
          appendTransaction(transactions, _old, state) {
            return transactions.some((tr) => tr.getMeta('appendExternalTyping'))
              ? state.tr.insertText('T')
              : null
          }
        })
      ]
    })
    const editor = createEditor(undefined, [appendTyping])
    const initial = editor.state.doc
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('ABCDE'), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    await flush()
    expect(editor.state.doc.child(0).textContent).toBe('hello AB')
    editor.view.dispatch(
      editor.state.tr
        .setSelection(
          TextSelection.create(editor.state.doc, editor.state.doc.child(0).nodeSize + 1)
        )
        .setMeta('appendExternalTyping', true)
    )
    const typed = editor.state.doc
    expect(typed.child(1).textContent).toBe('Tsecond paragraph')
    delay.resume()
    await flush()
    expect(editor.state.doc.child(0).textContent).toBe('hello ABCDE')
    expect(editor.state.doc.child(1).textContent).toBe('Tsecond paragraph')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(typed)).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.child(0).textContent).toBe('hello AB')
    expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.state.doc.eq(initial)).toBe(true)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('cancels when an external appended edit replaces the pending selected text', async () => {
    const appendTargetEdit = Extension.create({
      name: 'appendTargetEdit',
      addProseMirrorPlugins: () => [
        new Plugin({
          appendTransaction(transactions, _old, state) {
            return transactions.some((tr) => tr.getMeta('appendTargetEdit'))
              ? state.tr.insertText('changed', 7, 12)
              : null
          }
        })
      ]
    })
    const editor = createEditor(undefined, [appendTargetEdit])
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    editor.view.dispatch(
      editor.state.tr
        .setSelection(TextSelection.create(editor.state.doc, 14))
        .setMeta('appendTargetEdit', true)
    )
    const changed = editor.state.doc
    expect(changed.child(0).textContent).toBe('hello changed')
    delay.resume()
    await flush()
    expect(editor.state.doc.eq(changed)).toBe(true)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith(
      'Large paste cancelled because its original target changed.'
    )
    expect(document.activeElement).toBe(editor.view.dom)
  })
})
