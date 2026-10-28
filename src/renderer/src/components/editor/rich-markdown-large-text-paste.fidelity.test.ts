// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'
import {
  captureRichMarkdownClipboardInsertionOrder,
  richMarkdownClipboardInsertionOrderKey
} from './rich-markdown-clipboard-insertion-order'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const editors: Editor[] = []

function createProductionEditor(content = 'hello world\n\nsecond paragraph') {
  const editor = new Editor({
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
  editors.push(editor)
  document.body.append(editor.view.dom)
  editor.view.dom.focus()
  editor.commands.setTextSelection({ from: 7, to: 12 })
  return editor
}

function pasteEvent(text = 'ABCDE'): ClipboardEvent {
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

async function flush(count = 40) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

function paragraphs(editor: Editor): string[] {
  return Array.from(
    { length: editor.state.doc.childCount },
    (_, index) => editor.state.doc.child(index).textContent
  )
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('keeps every byte literal with the production extensions across production chunk boundaries', async () => {
  const editor = createProductionEditor()
  const payload = 'PASTE_SENTINEL '.repeat(5500)
  expect(new TextEncoder().encode(payload).byteLength).toBe(82500)
  const event = pasteEvent(payload)
  const delay = pause()
  const yieldToEventLoop = vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
  expect(handleRichMarkdownLargeTextPaste(editor, event, { yieldToEventLoop })).toBe(true)
  expect(event.defaultPrevented).toBe(true)
  expect(yieldToEventLoop).toHaveBeenCalledOnce()
  editor.commands.setTextSelection(14)
  delay.resume()
  await flush()
  expect(editor.state.doc.child(0).textContent === `hello ${payload}`).toBe(true)
  expect(editor.state.doc.child(0).textContent.match(/PASTE_SENTINEL/g)?.length).toBe(5500)
  expect(editor.state.doc.child(1).textContent).toBe('second paragraph')
  expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  let markedPayload = false
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text?.includes('PASTE')) {
      markedPayload ||= node.marks.length > 0
    }
  })
  expect(markedPayload).toBe(false)
  editor.commands.insertContent('!')
  expect(editor.state.doc.child(1).textContent).toBe('!second paragraph')
})

it('continues after its own chunk converts a document link while the live caret is elsewhere', async () => {
  const editor = createProductionEditor('hello world\n\nother paragraph')
  let firstYield = true
  handleRichMarkdownLargeTextPaste(editor, pasteEvent('aaa[[y]]ZZZ'), {
    directMaxBytes: 1,
    chunkMaxBytes: 8,
    measureYieldAfterCodeUnits: 1,
    yieldToEventLoop: async () => {
      if (firstYield) {
        firstYield = false
        editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
      }
    }
  })
  await flush(60)
  expect(editor.getMarkdown()).toBe('hello aaa[[y]]ZZZ\n\nother paragraph')
  expect(editor.view.dom.querySelector('[data-doc-link-target="y"]')).not.toBeNull()
  expect(editor.state.selection.from).toBe(editor.state.doc.child(0).nodeSize + 1)
  expect(toast.info).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  editor.state.doc.check()
  editor.commands.insertContent('!')
  expect(editor.getMarkdown()).toBe('hello aaa[[y]]ZZZ\n\n!other paragraph')
})

it.each(['first', 'second', 'interleaved'] as const)(
  'preserves two pending paste requests, live caret and chronological Undo when %s completes first',
  async (schedule) => {
    vi.spyOn(Date, 'now').mockReturnValue(10000)
    const editor = createProductionEditor()
    editor.commands.setTextSelection(7)
    const initialPlugins = editor.state.plugins.length
    const first = pause()
    const second = pause()
    const middle = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('AABB'), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      measureYieldAfterCodeUnits: 1,
      yieldToEventLoop: vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockImplementation(() =>
          schedule === 'interleaved' && paragraphs(editor)[0] === 'hello AAworld'
            ? middle.promise
            : Promise.resolve()
        )
    })
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('CCDD'), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      measureYieldAfterCodeUnits: 1,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(second.promise).mockResolvedValue(undefined)
    })
    expect(paragraphs(editor)[0]).toBe('hello world')
    if (schedule === 'second') {
      second.resume()
      await flush()
      expect(paragraphs(editor)[0]).toBe('hello CCDDworld')
    }
    first.resume()
    await flush()
    if (schedule !== 'second') {
      expect(paragraphs(editor)[0]).toBe(
        schedule === 'interleaved' ? 'hello AAworld' : 'hello AABBworld'
      )
      second.resume()
      await flush()
    }
    middle.resume()
    await flush()
    expect(paragraphs(editor)).toEqual(['hello AABBCCDDworld', 'second paragraph'])
    expect(editor.state.selection.from).toBe(15)
    expect(document.activeElement).toBe(editor.view.dom)
    expect(editor.state.plugins.length).toBe(initialPlugins)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    editor.state.doc.check()
    const undoStates =
      schedule === 'interleaved'
        ? ['hello AACCDDworld', 'hello AAworld', 'hello world']
        : [schedule === 'first' ? 'hello AABBworld' : 'hello CCDDworld', 'hello world']
    for (const expected of undoStates) {
      expect(editor.commands.undo()).toBe(true)
      expect(paragraphs(editor)).toEqual([expected, 'second paragraph'])
    }
    expect(editor.commands.undo()).toBe(false)
  }
)

it('groups native composition updates without a pending paste', () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000)
  const editor = createProductionEditor()
  const position = editor.state.doc.child(0).nodeSize + 1
  editor.commands.setTextSelection(position)
  editor.view.dispatch(editor.state.tr.insertText('n').setMeta('composition', 7))
  editor.view.dispatch(
    editor.state.tr.insertText('你', position, position + 1).setMeta('composition', 7)
  )
  expect(paragraphs(editor)[1]).toBe('你second paragraph')
  expect(editor.commands.undo()).toBe(true)
  expect(paragraphs(editor)[1]).toBe('second paragraph')
})

it.each(['typing', 'composition'] as const)(
  'preserves native %s Undo grouping during a paused paste',
  async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(10000)
    const editor = createProductionEditor()
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    await flush()
    const position = editor.state.doc.child(0).nodeSize + 1
    editor.commands.setTextSelection(position)
    if (mode === 'typing') {
      editor.view.dispatch(editor.state.tr.insertText('T'))
      editor.view.dispatch(editor.state.tr.insertText('U'))
    } else {
      editor.view.dispatch(editor.state.tr.insertText('n').setMeta('composition', 7))
      editor.view.dispatch(
        editor.state.tr.insertText('你', position, position + 1).setMeta('composition', 7)
      )
    }
    const finishedTyping = mode === 'typing' ? 'TUsecond paragraph' : '你second paragraph'
    expect(paragraphs(editor)[1]).toBe(finishedTyping)
    delay.resume()
    await flush()
    expect(paragraphs(editor)).toEqual(['hello ABCDE', finishedTyping])
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)).toEqual(['hello AB', finishedTyping])
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)).toEqual(['hello AB', 'second paragraph'])
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)).toEqual(['hello world', 'second paragraph'])
  }
)

it.each(['disabled', 'disconnected'] as const)(
  'isolates partial paste history after a %s editor becomes available again',
  async (condition) => {
    vi.spyOn(Date, 'now').mockReturnValue(10000)
    const editor = createProductionEditor()
    const initialPlugins = editor.state.plugins.length
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    await flush()
    expect(paragraphs(editor)[0]).toBe('hello AB')
    if (condition === 'disabled') {
      editor.setEditable(false)
    } else {
      editor.view.dom.remove()
    }
    delay.resume()
    await flush()
    expect(editor.state.plugins.length).toBe(initialPlugins)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith('Large paste stopped before it finished.')
    expect(toast.error).not.toHaveBeenCalled()
    if (condition === 'disabled') {
      editor.setEditable(true)
    } else {
      document.body.append(editor.view.dom)
    }
    editor.view.dom.focus()
    editor.commands.insertContent('T')
    expect(paragraphs(editor)[0]).toBe('hello ABT')
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)[0]).toBe('hello AB')
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)[0]).toBe('hello world')
  }
)

it('ignores a filtered foreign edit when separating a later accepted edit from paste history', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(10000)
  const editor = createProductionEditor()
  const delay = pause()
  handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
    directMaxBytes: 1,
    chunkMaxBytes: 2,
    yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
  })
  await flush()
  editor.registerPlugin(new Plugin({ filterTransaction: (tr) => !tr.getMeta('rejectForeign') }))
  const position = editor.state.doc.child(0).nodeSize + 1
  editor.commands.setTextSelection(position)
  editor.view.dispatch(editor.state.tr.insertText('rejected').setMeta('rejectForeign', true))
  expect(paragraphs(editor)[1]).toBe('second paragraph')
  editor.view.dispatch(editor.state.tr.insertText('T'))
  delay.resume()
  await flush()
  expect(paragraphs(editor)).toEqual(['hello ABCDE', 'Tsecond paragraph'])
  expect(editor.commands.undo()).toBe(true)
  expect(paragraphs(editor)).toEqual(['hello AB', 'Tsecond paragraph'])
  expect(editor.commands.undo()).toBe(true)
  expect(paragraphs(editor)).toEqual(['hello AB', 'second paragraph'])
  expect(editor.commands.undo()).toBe(true)
  expect(paragraphs(editor)).toEqual(['hello world', 'second paragraph'])
})

it.each(['typing', 'composition'] as const)(
  'keeps a cancelling target edit and subsequent native %s grouped after cleanup',
  async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(10000)
    const editor = createProductionEditor()
    const initialPlugins = editor.state.plugins.length
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    await flush()
    expect(paragraphs(editor)[0]).toBe('hello AB')
    const edit = editor.state.tr.insertText(mode === 'typing' ? 'T' : 'n', 8, 9)
    editor.view.dispatch(mode === 'composition' ? edit.setMeta('composition', 7) : edit)
    delay.resume()
    await flush()
    expect(editor.state.plugins.length).toBe(initialPlugins)
    expect(toast.info).toHaveBeenCalledExactlyOnceWith('Large paste stopped before it finished.')
    expect(toast.error).not.toHaveBeenCalled()
    if (mode === 'typing') {
      editor.view.dispatch(editor.state.tr.insertText('U'))
    } else {
      editor.view.dispatch(editor.state.tr.insertText('你', 8, 9).setMeta('composition', 7))
    }
    expect(paragraphs(editor)[0]).toBe(mode === 'typing' ? 'hello ATU' : 'hello A你')
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)[0]).toBe('hello AB')
    expect(editor.commands.undo()).toBe(true)
    expect(paragraphs(editor)[0]).toBe('hello world')
  }
)

it('rejects the actual 16 MiB limit plus one emoji without changing the document or retaining plugins', async () => {
  const editor = createProductionEditor()
  const initial = editor.state.doc
  const initialPlugins = editor.state.plugins.length
  const payload = '😀'.repeat(4 * 1024 * 1024 + 1)
  expect(
    handleRichMarkdownLargeTextPaste(editor, pasteEvent(payload), {
      yieldToEventLoop: async () => {}
    })
  ).toBe(true)
  await flush(1000)
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('Paste is too large.')
  expect(toast.info).not.toHaveBeenCalled()
  expect(editor.state.doc.eq(initial)).toBe(true)
  expect(editor.state.plugins.length).toBe(initialPlugins)
  editor.state.doc.check()
})

it.each(['earlier image', 'later image', 'ordinary typing'] as const)(
  'orders a pending text paste against %s without changing the live caret',
  async (counterpart) => {
    const editor = createProductionEditor()
    editor.commands.setTextSelection(7)
    const earlierOrder =
      counterpart === 'earlier image' ? captureRichMarkdownClipboardInsertionOrder(editor) : null
    const delay = pause()
    handleRichMarkdownLargeTextPaste(editor, pasteEvent('ABCD'), {
      directMaxBytes: 1,
      chunkMaxBytes: 2,
      measureYieldAfterCodeUnits: 1,
      yieldToEventLoop: vi.fn().mockReturnValueOnce(delay.promise).mockResolvedValue(undefined)
    })
    if (counterpart === 'ordinary typing') {
      editor.commands.insertContent('typed ')
    } else {
      const order = earlierOrder ?? captureRichMarkdownClipboardInsertionOrder(editor)
      editor.view.dispatch(
        editor.state.tr
          .insert(7, editor.schema.nodes.image.create({ src: 'counterpart.png' }))
          .setMeta(richMarkdownClipboardInsertionOrderKey, order)
      )
    }
    const caret = editor.state.selection.from
    delay.resume()
    await flush()
    const expected =
      counterpart === 'earlier image'
        ? 'hello ![](counterpart.png)ABCDworld'
        : counterpart === 'later image'
          ? 'hello ABCD![](counterpart.png)world'
          : 'hello ABCDtyped world'
    expect(editor.getMarkdown()).toBe(`${expected}\n\nsecond paragraph`)
    expect(editor.state.selection.from).toBe(caret + 4)
    expect(document.activeElement).toBe(editor.view.dom)
    expect(toast.info).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    editor.state.doc.check()
  }
)
