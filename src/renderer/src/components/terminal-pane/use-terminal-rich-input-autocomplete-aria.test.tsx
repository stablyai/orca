// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import { useTerminalRichInputAutocompleteAria } from './use-terminal-rich-input-autocomplete-aria'

function Probe({ editor, open }: { editor: Editor; open: boolean }): null {
  useTerminalRichInputAutocompleteAria({
    editor,
    fileMenuOpen: open,
    fileSuggestionCount: 2,
    slashMenuOpen: false,
    slashSuggestionCount: 0,
    activeSuggestion: 1
  })
  return null
}

describe('useTerminalRichInputAutocompleteAria', () => {
  it('connects and clears the editor autocomplete relationship', async () => {
    const editorElement = document.createElement('div')
    const editor = { isDestroyed: false, view: { dom: editorElement } } as unknown as Editor
    const root = createRoot(document.createElement('div'))

    await act(async () => root.render(<Probe editor={editor} open />))
    const menuId = editorElement.getAttribute('aria-controls')
    expect(editorElement.getAttribute('aria-expanded')).toBe('true')
    expect(menuId).toContain('-files')
    expect(editorElement.getAttribute('aria-activedescendant')).toBe(`${menuId}-option-1`)

    await act(async () => root.render(<Probe editor={editor} open={false} />))
    expect(editorElement.getAttribute('aria-expanded')).toBe('false')
    expect(editorElement.hasAttribute('aria-controls')).toBe(false)
    expect(editorElement.hasAttribute('aria-activedescendant')).toBe(false)
    root.unmount()
  })
})
