// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, expect, it } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

// Production extends the lowlight extension again to add its node view.
function mountExtended(content: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      RichMarkdownCodeBlockLowlight.extend({}).configure({ lowlight: createLowlight(common) })
    ],
    content
  })
  editors.push(editor)
  return editor
}

it('installs one highlighting plugin when the extension is extended', () => {
  const editor = mountExtended(
    '<pre><code class="language-javascript">const answer = 42;</code></pre>'
  )
  const highlightingStates = editor.state.plugins.flatMap((plugin) => {
    const state: unknown = plugin.getState(editor.state)
    return state instanceof DecorationSet ? [state] : []
  })
  expect(highlightingStates).toHaveLength(1)
  expect(highlightingStates[0].find().length).toBeGreaterThan(0)
})

it('keeps VS Code paste when the extension is extended', () => {
  const editor = mountExtended('<p>Before</p>')
  editor.commands.selectAll()
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', 'const answer = 42;\r\nconsole.log(answer);')
  clipboardData.setData('vscode-editor-data', JSON.stringify({ mode: 'javascript' }))
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock')
  expect(editor.state.doc.firstChild?.attrs.language).toBe('javascript')
})
