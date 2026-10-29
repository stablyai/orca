// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function mount(language: string | null) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      RichMarkdownCodeBlockLowlight.configure({
        lowlight: createLowlight(common),
        defaultLanguage: null
      })
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language },
          content: [{ type: 'text', text: 'const answer = 42;' }]
        }
      ]
    }
  })
  editors.push(editor)
  const spans = () => editor.view.dom.querySelectorAll('[class*="hljs-"]').length
  return { editor, spans }
}

it('keeps unlabeled code blocks uncolored after edits', () => {
  const { editor, spans } = mount(null)
  expect(spans()).toBe(0)
  editor.view.dispatch(editor.state.tr.insertText('changed ', 1))
  expect(spans()).toBe(0)
})

it('removes syntax colors when choosing Plain text', () => {
  const { editor, spans } = mount('javascript')
  expect(spans()).toBeGreaterThan(0)
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { language: '' }))
  expect(spans()).toBe(0)
})
