import React, { useRef } from 'react'
import type { Editor } from '@tiptap/react'
import { EditorContent } from '@tiptap/react'
import { RichMarkdownTableControls } from '@/components/editor/RichMarkdownTableControls'

export function GitHubMarkdownComposerEditorPane({
  disabled,
  editor
}: {
  disabled: boolean
  editor: Editor | null
}): React.JSX.Element {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      ref={scrollContainerRef}
      className="relative max-h-[360px] overflow-y-auto scrollbar-sleek"
    >
      <EditorContent editor={editor} />
      <RichMarkdownTableControls
        disabled={disabled}
        editor={editor}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  )
}
