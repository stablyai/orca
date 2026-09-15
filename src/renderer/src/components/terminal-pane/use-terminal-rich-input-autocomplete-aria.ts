import { useEffect, useId } from 'react'
import type { Editor } from '@tiptap/react'

export function useTerminalRichInputAutocompleteAria({
  editor,
  fileMenuOpen,
  fileSuggestionCount,
  slashMenuOpen,
  slashSuggestionCount,
  activeSuggestion
}: {
  editor: Editor | null
  fileMenuOpen: boolean
  fileSuggestionCount: number
  slashMenuOpen: boolean
  slashSuggestionCount: number
  activeSuggestion: number
}): { fileMenuId: string; slashMenuId: string; activeIndex: number } {
  const autocompleteId = useId()
  const fileMenuId = `${autocompleteId}-files`
  const slashMenuId = `${autocompleteId}-slashes`
  const activeMenuId = fileMenuOpen ? fileMenuId : slashMenuOpen ? slashMenuId : null
  const suggestionCount = fileMenuOpen
    ? fileSuggestionCount
    : slashMenuOpen
      ? slashSuggestionCount
      : 0
  const activeIndex = suggestionCount > 0 ? Math.min(activeSuggestion, suggestionCount - 1) : 0
  const activeOptionId =
    activeMenuId && suggestionCount > 0 ? `${activeMenuId}-option-${activeIndex}` : null

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return
    }
    const editorElement = editor.view.dom
    editorElement.setAttribute('aria-expanded', activeMenuId ? 'true' : 'false')
    if (activeMenuId) {
      editorElement.setAttribute('aria-controls', activeMenuId)
    } else {
      editorElement.removeAttribute('aria-controls')
    }
    if (activeOptionId) {
      editorElement.setAttribute('aria-activedescendant', activeOptionId)
    } else {
      editorElement.removeAttribute('aria-activedescendant')
    }
  }, [activeMenuId, activeOptionId, editor])

  return { fileMenuId, slashMenuId, activeIndex }
}
