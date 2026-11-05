import { useEffect } from 'react'
import type { Editor } from '@tiptap/react'

export function getRichMarkdownSpellcheckAttribute(enabled: boolean): 'true' | 'false' {
  return enabled ? 'true' : 'false'
}

export function useRichMarkdownSpellcheckAttribute(editor: Editor | null, enabled: boolean): void {
  useEffect(() => {
    editor?.view.dom.setAttribute('spellcheck', getRichMarkdownSpellcheckAttribute(enabled))
  }, [editor, enabled])
}
