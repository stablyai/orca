import { useEffect, useState } from 'react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RichMarkdownToolbar } from './RichMarkdownToolbar'

const CONTENT = '<p>Orca counts the words in this paragraph.</p>'

function ToolbarFixture({ selection }: { selection?: 'all' }): React.JSX.Element | null {
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    const instance = new Editor({ extensions: [StarterKit], content: CONTENT })
    if (selection === 'all') {
      instance.commands.setTextSelection({ from: 1, to: 1 + 'Orca counts the'.length })
    }
    setEditor(instance)
    return () => instance.destroy()
  }, [selection])

  return editor ? (
    <div className="rich-markdown-editor-layout" style={{ width: 720 }}>
      <RichMarkdownToolbar editor={editor} onToggleLink={() => {}} onImagePick={() => {}} />
    </div>
  ) : null
}

export const documentCount = defineFixture({ width: 720, render: () => <ToolbarFixture /> })

export const selectionCount = defineFixture({
  width: 720,
  render: () => <ToolbarFixture selection="all" />
})
