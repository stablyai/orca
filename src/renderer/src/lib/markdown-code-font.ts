import { resolveEditorFontStack } from '@/lib/editor-typography'

/**
 * Markdown code follows only an explicitly chosen editor font, so an unset one keeps
 * today's app monospace instead of switching every document to the terminal font.
 */
export function applyMarkdownCodeFontFamily(editorFontFamily: string | undefined): void {
  const style = document.documentElement.style
  if (editorFontFamily?.trim()) {
    style.setProperty('--markdown-code-font-family', resolveEditorFontStack({ editorFontFamily }))
  } else {
    style.removeProperty('--markdown-code-font-family')
  }
}
