// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import { DecorationSet, type Decoration } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { NativeChatUnkernedRunDecorations } from './native-chat-unkerned-run-decorations'
import { promptTextContent } from './native-chat-prompt-document'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function decorations(state: EditorState): Decoration[] {
  return state.plugins.flatMap((plugin) => {
    const set = plugin.props.decorations?.call(plugin, state)
    return set instanceof DecorationSet ? set.find() : []
  })
}

const ranges = (state: EditorState) => decorations(state).map(({ from, to }) => [from, to])

// One block of long runs split by spaces and Shift+Enter breaks, as a pasted log can be.
function longRunBlock(runs: number): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: Array.from({ length: runs }, (_, index): JSONContent[] => [
          { type: 'text', text: `${'x'.repeat(300)}${index % 2 ? ' ' : ''}` },
          ...(index % 2 ? [] : [{ type: 'hardBreak' }])
        ]).flat()
      }
    ]
  }
}

it('re-checks only the edited run of a long block and agrees with a full scan', () => {
  editor = new Editor({ extensions: [StarterKit, NativeChatUnkernedRunDecorations] })
  const { plugins } = editor.extensionManager
  const before = EditorState.create({
    doc: editor.schema.nodeFromJSON(longRunBlock(2000)),
    plugins
  })
  const old = decorations(before)
  expect(old).toHaveLength(2000)
  const edited = old[1000]
  const after = before.apply(before.tr.insertText(' ', edited.from + 150))
  const kept = decorations(after)
  expect(kept).toHaveLength(1999)
  const oldSpecs = new Set(old.map((decoration) => decoration.spec))
  expect(kept.every((decoration) => oldSpecs.has(decoration.spec))).toBe(true)
  expect(kept.some((decoration) => decoration.spec === edited.spec)).toBe(false)
  expect(ranges(after)).toEqual(ranges(EditorState.create({ doc: after.doc, plugins })))

  // Edits that complete or border a surrogate pair at the window's edge.
  const x = (count: number) => 'x'.repeat(count)
  const edits: [string, (state: EditorState) => Transaction][] = [
    ['\uD840', (state) => state.tr.insertText(`\uDC00${x(300)}`, 2)],
    [`\uD840 \uDC00${x(300)}`, (state) => state.tr.delete(2, 3)],
    [' \uDC00', (state) => state.tr.insertText(x(256), 3)]
  ]
  for (const [text, edit] of edits) {
    const start = EditorState.create({
      doc: editor.schema.nodeFromJSON(promptTextContent(text)),
      plugins
    })
    const edited = start.apply(edit(start))
    expect(ranges(edited)).toEqual(ranges(EditorState.create({ doc: edited.doc, plugins })))
  }
})

it('waits for an IME composition to end before redecorating, then rescans', async () => {
  const element = document.createElement('div')
  editor = new Editor({
    element,
    extensions: [StarterKit, NativeChatUnkernedRunDecorations],
    content: `<p>${'x'.repeat(400)}</p>`
  })
  const { view } = editor
  const unkerned = () => element.querySelectorAll('[style*="font-kerning"]').length
  expect(unkerned()).toBe(1)
  view.dispatch(view.state.tr.insertText(' ', 200).setMeta('composition', 1))
  expect(unkerned()).toBe(1)
  view.dom.dispatchEvent(new Event('compositionend'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(unkerned()).toBe(0)
  expect(ranges(view.state)).toEqual([])
})
