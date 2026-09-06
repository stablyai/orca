import { formatCopiedSelectionWithContext } from '../selection-copy'
import { editorShortcutMatches } from '../editor-shortcuts'

/** Resolves the 1-based line of the row containing a selection boundary node. */
function lineOf(node: Node | null): number | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  const row = element?.closest('[data-line]')
  const raw = row?.getAttribute('data-line')
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Restores `editor.copyContext` for Pierre-rendered diffs. Monaco exposed the
 * selection as an IRange; here the equivalent comes from the shadow root's
 * selection, resolved back to line numbers through Pierre's `data-line` rows.
 */
export function installPierreContextualCopy(
  container: HTMLElement,
  getFileInfo: () => { relativePath: string; language: string }
): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!editorShortcutMatches('editor.copyContext', event)) {
      return
    }
    const host = container.querySelector('diffs-container')
    const root = host?.shadowRoot
    // Why: Chromium scopes the selection to the shadow root that owns the range.
    const selection = (
      root as unknown as { getSelection?: () => Selection | null }
    )?.getSelection?.()
    const selectedText = selection?.toString() ?? ''
    if (!selectedText) {
      return
    }
    const startLine = lineOf(selection?.anchorNode ?? null)
    const endLine = lineOf(selection?.focusNode ?? null)
    if (startLine == null || endLine == null) {
      return
    }
    const { relativePath, language } = getFileInfo()
    const formatted = formatCopiedSelectionWithContext({
      relativePath,
      language,
      selectedText,
      selection: {
        startLineNumber: Math.min(startLine, endLine),
        endLineNumber: Math.max(startLine, endLine),
        startColumn: 1,
        endColumn: 1
      }
    })
    if (!formatted) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    void navigator.clipboard.writeText(formatted)
  }

  container.addEventListener('keydown', handleKeyDown, true)
  return () => container.removeEventListener('keydown', handleKeyDown, true)
}
