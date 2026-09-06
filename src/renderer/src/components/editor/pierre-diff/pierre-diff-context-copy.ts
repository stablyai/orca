import { formatCopiedSelectionWithContext } from '../selection-copy'
import { editorShortcutMatches } from '../editor-shortcuts'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  isPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'

const PRIMARY_SELECTION_DEBOUNCE_MS = 200

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
  // Why: Monaco drew this as a content widget; Pierre has no widget layer, so it
  // is an overlay pinned to the selection's client rect instead.
  const hint = document.createElement('div')
  hint.className =
    'pointer-events-none fixed z-50 rounded-md border border-border/90 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-[0_6px_18px_rgba(15,23,42,0.18)] backdrop-blur whitespace-nowrap'
  hint.style.display = 'none'
  document.body.appendChild(hint)
  let primarySelectionTimer: number | null = null

  const readSelection = (): Selection | null => {
    const root = container.querySelector('diffs-container')?.shadowRoot
    return (root as unknown as { getSelection?: () => Selection | null })?.getSelection?.() ?? null
  }

  const hideHint = (): void => {
    hint.style.display = 'none'
  }

  const updateHint = (): void => {
    const selection = readSelection()
    const text = selection?.toString() ?? ''
    const startLine = lineOf(selection?.anchorNode ?? null)
    const endLine = lineOf(selection?.focusNode ?? null)
    // Why: copy-with-context is a multi-line affordance; a single line copies plainly.
    if (!text || startLine == null || endLine == null || startLine === endLine) {
      hideHint()
      return
    }
    hint.textContent = `Copy context ${formatShortcutLabel(
      'editor.copyContext',
      useAppStore.getState().keybindings
    )}`
    const rect = selection?.getRangeAt(0).getBoundingClientRect()
    if (!rect || rect.width === 0) {
      hideHint()
      return
    }
    hint.style.display = 'block'
    const above = rect.top > hint.offsetHeight + 12
    hint.style.left = `${Math.round(rect.left)}px`
    hint.style.top = `${Math.round(above ? rect.top - hint.offsetHeight - 8 : rect.bottom + 8)}px`
  }

  // Why: mirrors the editor's selection-clipboard debounce so a drag does not churn X11's buffer.
  const updatePrimarySelection = (): void => {
    if (!isPrimarySelectionEnabled()) {
      return
    }
    const text = readSelection()?.toString() ?? ''
    if (!text || text.length > PRIMARY_SELECTION_MAX_LENGTH) {
      return
    }
    setPrimarySelectionText(text)
  }

  const handleSelectionChange = (): void => {
    updateHint()
    if (primarySelectionTimer !== null) {
      window.clearTimeout(primarySelectionTimer)
    }
    primarySelectionTimer = window.setTimeout(updatePrimarySelection, PRIMARY_SELECTION_DEBOUNCE_MS)
  }

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
    hideHint()
  }

  container.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('selectionchange', handleSelectionChange)
  return () => {
    container.removeEventListener('keydown', handleKeyDown, true)
    document.removeEventListener('selectionchange', handleSelectionChange)
    if (primarySelectionTimer !== null) {
      window.clearTimeout(primarySelectionTimer)
    }
    hint.remove()
  }
}
