// @vitest-environment happy-dom

import { Editor, type JSONContent } from '@tiptap/core'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TextSelection, type Plugin } from '@tiptap/pm/state'
import type { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, describe, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

type Lowlight = ReturnType<typeof createLowlight>
type Counters = { highlight: number; highlightAuto: number; listLanguages: number }
type RuntimeKeyedPlugin = Plugin & { key?: string }
type DecorationWithAttrs = Decoration & {
  type: { attrs?: { class?: string } }
}

function observedLowlight(counters: Counters): Lowlight {
  const base = createLowlight(common)
  return {
    ...base,
    highlight: (...args) => {
      counters.highlight += 1
      return base.highlight(...args)
    },
    highlightAuto: (...args) => {
      counters.highlightAuto += 1
      return base.highlightAuto(...args)
    },
    listLanguages: () => {
      counters.listLanguages += 1
      return base.listLanguages()
    }
  }
}

function documentWithCodeBlocks(count = 3): JSONContent {
  return {
    type: 'doc',
    content: Array.from({ length: count }, (_, index) => [
      { type: 'paragraph', content: [{ type: 'text', text: `paragraph ${index}` }] },
      {
        type: 'codeBlock',
        attrs: { language: index === 1 ? 'js' : index === 2 ? 'unknown' : 'typescript' },
        content: [{ type: 'text', text: `const value${index}: number = ${index}` }]
      }
    ]).flat()
  }
}

function createEditor({
  incremental,
  counters,
  content = documentWithCodeBlocks(),
  defaultLanguage = null
}: {
  incremental: boolean
  counters: Counters
  content?: JSONContent
  defaultLanguage?: string | null
}): Editor {
  const extension = incremental ? RichMarkdownCodeBlockLowlight : CodeBlockLowlight
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      extension.configure({ lowlight: observedLowlight(counters), defaultLanguage })
    ],
    content
  })
}

function nodePositions(editor: Editor, name: string): number[] {
  const positions: number[] = []
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === name) {
      positions.push(pos)
    }
  })
  return positions
}

function decorationSnapshot(editor: Editor, incremental: boolean): unknown[] {
  const keyPrefix = incremental ? 'richMarkdownLowlight$' : 'lowlight$'
  const plugin = editor.state.plugins.find((candidate) =>
    (candidate as RuntimeKeyedPlugin).key?.startsWith(keyPrefix)
  )
  const decorations = plugin?.getState(editor.state) as DecorationSet | undefined
  if (!decorations) {
    const keys = editor.state.plugins.map((candidate) => (candidate as RuntimeKeyedPlugin).key)
    throw new Error(`Missing ${keyPrefix} plugin: ${JSON.stringify(keys)}`)
  }
  return decorations.find().map((decoration) => {
    const typed = decoration as DecorationWithAttrs
    return [decoration.from, decoration.to, typed.type.attrs?.class]
  })
}

function expectParity(stock: Editor, incremental: Editor): void {
  expect(incremental.state.doc.toJSON()).toEqual(stock.state.doc.toJSON())
  expect(decorationSnapshot(incremental, true)).toEqual(decorationSnapshot(stock, false))
}

function resetCounters(counters: Counters): void {
  counters.highlight = 0
  counters.highlightAuto = 0
  counters.listLanguages = 0
}

describe('incremental rich markdown lowlight', () => {
  const editors: Editor[] = []

  afterEach(() => {
    for (const editor of editors) {
      editor.destroy()
    }
    editors.length = 0
  })

  function createPair(content?: JSONContent, defaultLanguage: string | null = null) {
    const stockCounters = { highlight: 0, highlightAuto: 0, listLanguages: 0 }
    const incrementalCounters = { highlight: 0, highlightAuto: 0, listLanguages: 0 }
    const stock = createEditor({
      incremental: false,
      counters: stockCounters,
      content,
      defaultLanguage
    })
    const incremental = createEditor({
      incremental: true,
      counters: incrementalCounters,
      content,
      defaultLanguage
    })
    editors.push(stock, incremental)
    return { stock, incremental, stockCounters, incrementalCounters }
  }

  it('matches stock decorations for named, aliased, and unknown languages', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair()

    expectParity(stock, incremental)
    expect(stockCounters).toEqual({ highlight: 2, highlightAuto: 1, listLanguages: 3 })
    expect(incrementalCounters).toEqual({ highlight: 2, highlightAuto: 1, listLanguages: 1 })
  })

  it('matches stock decorations when a default language is configured', () => {
    const content = documentWithCodeBlocks(1)
    const codeBlock = content.content?.[1]
    if (!codeBlock?.attrs) {
      throw new Error('Missing code block')
    }
    codeBlock.attrs.language = null
    const { stock, incremental, stockCounters, incrementalCounters } = createPair(
      content,
      'typescript'
    )

    expectParity(stock, incremental)
    expect(stockCounters.highlight).toBe(1)
    expect(incrementalCounters.highlight).toBe(1)
  })

  it('maps decorations without highlighting after a prose edit', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair()
    resetCounters(stockCounters)
    resetCounters(incrementalCounters)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'paragraph')[0] + 1
      editor.view.dispatch(editor.state.tr.insertText('x', pos))
    }

    expectParity(stock, incremental)
    expect(stockCounters.highlight + stockCounters.highlightAuto).toBe(0)
    expect(incrementalCounters.highlight + incrementalCounters.highlightAuto).toBe(0)
  })

  it('highlights only the edited code block', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair()
    resetCounters(stockCounters)
    resetCounters(incrementalCounters)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      editor.view.dispatch(tr.insertText('x'))
    }

    expectParity(stock, incremental)
    expect(stockCounters.highlight + stockCounters.highlightAuto).toBe(3)
    expect(incrementalCounters.highlight + incrementalCounters.highlightAuto).toBe(1)
  })

  it('highlights only the code blocks touched by a multi-step transaction', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair()
    resetCounters(stockCounters)
    resetCounters(incrementalCounters)

    for (const editor of [stock, incremental]) {
      const [first, , third] = nodePositions(editor, 'codeBlock').map((pos) => pos + 1)
      const tr = editor.state.tr.insertText('z', third).insertText('a', first)
      tr.setSelection(TextSelection.create(tr.doc, first))
      editor.view.dispatch(tr)
    }

    expectParity(stock, incremental)
    expect(stockCounters.highlight + stockCounters.highlightAuto).toBe(3)
    expect(incrementalCounters.highlight + incrementalCounters.highlightAuto).toBe(2)
  })

  it('falls back safely for a language attribute change', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0]
      const node = editor.state.doc.nodeAt(pos)
      const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
        ...node?.attrs,
        language: 'javascript'
      })
      tr.setSelection(TextSelection.create(tr.doc, pos + 1))
      editor.view.dispatch(tr)
    }

    expectParity(stock, incremental)
  })

  it('preserves parity when code blocks are inserted and deleted', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const end = editor.state.doc.content.size
      const codeBlock = editor.schema.nodes.codeBlock.create(
        { language: 'typescript' },
        editor.schema.text('let inserted = true')
      )
      editor.view.dispatch(editor.state.tr.insert(end, codeBlock))
    }
    expectParity(stock, incremental)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[1]
      const node = editor.state.doc.nodeAt(pos)
      if (!node) {
        throw new Error('Missing code block')
      }
      editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
    }
    expectParity(stock, incremental)
  })

  it('preserves parity through undo and redo', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      editor.view.dispatch(tr.insertText('undoable'))
    }
    expectParity(stock, incremental)

    expect(stock.commands.undo()).toBe(true)
    expect(incremental.commands.undo()).toBe(true)
    expectParity(stock, incremental)

    expect(stock.commands.redo()).toBe(true)
    expect(incremental.commands.redo()).toBe(true)
    expectParity(stock, incremental)
  })

  it('preserves parity when paragraphs and code blocks are converted', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'paragraph')[0] + 1
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      )
      expect(editor.commands.setCodeBlock({ language: 'typescript' })).toBe(true)
    }
    expectParity(stock, incremental)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      )
      expect(editor.commands.setParagraph()).toBe(true)
    }
    expectParity(stock, incremental)
  })

  it('preserves parity for paste and deletion inside a code block', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 2
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      )
      expect(editor.view.pasteText('pasted text')).toBe(true)
    }
    expectParity(stock, incremental)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      editor.view.dispatch(editor.state.tr.delete(pos, pos + 6))
    }
    expectParity(stock, incremental)
  })

  it('preserves parity when a code block is split and joined', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 8
      editor.view.dispatch(editor.state.tr.split(pos))
    }
    expectParity(stock, incremental)

    for (const editor of [stock, incremental]) {
      const joinPos = nodePositions(editor, 'codeBlock')[1]
      editor.view.dispatch(editor.state.tr.join(joinPos))
    }
    expectParity(stock, incremental)
  })

  it('preserves parity when a code block moves in one transaction', () => {
    const { stock, incremental } = createPair()

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0]
      const node = editor.state.doc.nodeAt(pos)
      if (!node) {
        throw new Error('Missing code block')
      }
      const tr = editor.state.tr.delete(pos, pos + node.nodeSize)
      const insertedAt = tr.doc.content.size
      tr.insert(insertedAt, node)
      tr.setSelection(TextSelection.create(tr.doc, insertedAt + 1))
      editor.view.dispatch(tr)
    }

    expectParity(stock, incremental)
  })

  it('preserves parity for code blocks nested in list items', () => {
    const content: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'item' }] },
                {
                  type: 'codeBlock',
                  attrs: { language: 'typescript' },
                  content: [{ type: 'text', text: 'const nested = true' }]
                }
              ]
            }
          ]
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] }
      ]
    }
    const { stock, incremental } = createPair(content)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      editor.view.dispatch(tr.insertText('x'))
    }

    expectParity(stock, incremental)
  })

  it('preserves parity after whole-document replacement', () => {
    const { stock, incremental } = createPair()

    expect(stock.commands.setContent(documentWithCodeBlocks(5))).toBe(true)
    expect(incremental.commands.setContent(documentWithCodeBlocks(5))).toBe(true)

    expectParity(stock, incremental)
  })

  it('does not highlight for selection-only transactions', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair()
    resetCounters(stockCounters)
    resetCounters(incrementalCounters)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      )
    }

    expectParity(stock, incremental)
    expect(stockCounters.highlight + stockCounters.highlightAuto).toBe(0)
    expect(incrementalCounters.highlight + incrementalCounters.highlightAuto).toBe(0)
  })

  it('replaces the stock plugin without dropping the code-block paste handler', () => {
    const counters = { highlight: 0, highlightAuto: 0, listLanguages: 0 }
    const editor = createEditor({ incremental: true, counters })
    editors.push(editor)
    const keys = editor.state.plugins.map((plugin) => (plugin as RuntimeKeyedPlugin).key)

    expect(RichMarkdownCodeBlockLowlight.options).toEqual(CodeBlockLowlight.options)
    expect(keys.some((key) => key?.startsWith('richMarkdownLowlight$'))).toBe(true)
    expect(keys.some((key) => key?.startsWith('lowlight$'))).toBe(false)
    expect(keys.some((key) => key?.startsWith('codeBlockVSCodeHandler$'))).toBe(true)
  })

  it('preserves parity at adjacent code-block boundaries', () => {
    const content: JSONContent = {
      type: 'doc',
      content: documentWithCodeBlocks(3).content?.filter((node) => node.type === 'codeBlock')
    }
    const { stock, incremental } = createPair(content)

    for (const editor of [stock, incremental]) {
      const firstPos = nodePositions(editor, 'codeBlock')[0]
      const first = editor.state.doc.nodeAt(firstPos)
      if (!first) {
        throw new Error('Missing first code block')
      }
      editor.view.dispatch(editor.state.tr.insertText('tail', firstPos + first.nodeSize - 1))
    }
    expectParity(stock, incremental)

    for (const editor of [stock, incremental]) {
      const firstPos = nodePositions(editor, 'codeBlock')[0]
      const first = editor.state.doc.nodeAt(firstPos)
      if (!first) {
        throw new Error('Missing first code block')
      }
      editor.view.dispatch(editor.state.tr.delete(firstPos, firstPos + first.nodeSize))
    }
    expectParity(stock, incremental)
  })

  it('rehighlights one of 533 code blocks after a local code edit', () => {
    const { stock, incremental, stockCounters, incrementalCounters } = createPair(
      documentWithCodeBlocks(533)
    )
    resetCounters(stockCounters)
    resetCounters(incrementalCounters)

    for (const editor of [stock, incremental]) {
      const pos = nodePositions(editor, 'codeBlock')[0] + 1
      const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
      editor.view.dispatch(tr.insertText('x'))
    }

    expectParity(stock, incremental)
    expect(stockCounters.highlight + stockCounters.highlightAuto).toBe(533)
    expect(incrementalCounters.highlight + incrementalCounters.highlightAuto).toBe(1)
    expect(incrementalCounters.listLanguages).toBe(0)
  })
})
