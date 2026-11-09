// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { DecorationSet, type Decoration } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { NativeChatUnkernedRunDecorations } from './native-chat-unkerned-run-decorations'

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
