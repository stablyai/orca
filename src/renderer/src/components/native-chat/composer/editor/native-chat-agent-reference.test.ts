// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import { insertAgentReferences, NativeChatAgentReference } from './native-chat-agent-reference'

let editor: Editor | undefined
afterEach(() => editor?.destroy())

function chips(target: Editor): unknown[][] {
  const found: unknown[][] = []
  target.state.doc.descendants((node) => {
    if (node.type.name === NativeChatAgentReference.name) {
      found.push([node.attrs.label, node.attrs.kind])
    }
  })
  return found
}

describe('insertAgentReferences', () => {
  it('inserts each agent once per kind', () => {
    editor = new Editor({ extensions: [StarterKit, NativeChatAgentReference] })
    const crew = { label: 'auth-tests', address: 'term_w1', hostKey: 'local' }
    const terminal = { ...crew, label: 'zsh', kind: 'terminal' as const }

    insertAgentReferences(editor, [crew, crew])
    insertAgentReferences(editor, [terminal, crew, terminal])

    expect(chips(editor)).toEqual([
      ['auth-tests', ''],
      ['zsh', 'terminal']
    ])
  })
})
