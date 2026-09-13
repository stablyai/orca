import { formatCopiedSelectionWithContext } from '../selection-copy'
import { editorShortcutMatches } from '../editor-shortcuts'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getPierreSelectionRange } from './pierre-diff-selection'
import {
  PRIMARY_SELECTION_MAX_LENGTH,
  isPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'

const PRIMARY_SELECTION_DEBOUNCE_MS = 200

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
    'pointer-events-none fixed z-50 rounded-md border border-border/90 bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-floating backdrop-blur whitespace-nowrap'
  hint.style.display = 'none'
  document.body.appendChild(hint)
  let primarySelectionTimer: number | null = null
  let disposed = false
  let lastCopiedSelection: string | null = null

  const readSelection = (): Selection | null => {
    const root = container.querySelector('diffs-container')?.shadowRoot
    const selection =
      (root as unknown as { getSelection?: () => Selection | null })?.getSelection?.() ?? null
    return root?.contains(selection?.anchorNode ?? null) &&
      root.contains(selection?.focusNode ?? null)
      ? selection
      : null
  }

  const hideHint = (): void => {
    hint.style.display = 'none'
  }

  const selectionKey = (selection: Selection | null): string => {
    const range = getPierreSelectionRange(selection)
    return JSON.stringify([getFileInfo().relativePath, range, selection?.toString()])
  }

  const updateHint = (): void => {
    const selection = readSelection()
    const text = selection?.toString() ?? ''
    const range = getPierreSelectionRange(selection)
    // Why: copy-with-context is a multi-line affordance; a single line copies plainly.
    if (
      !text ||
      selectionKey(selection) === lastCopiedSelection ||
      !range ||
      range.startLineNumber === range.endLineNumber
    ) {
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
    hint.style.left = `${Math.round(Math.max(0, Math.min(rect.left, window.innerWidth - hint.offsetWidth)))}px`
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
    if (selectionKey(readSelection()) !== lastCopiedSelection) {
      lastCopiedSelection = null
    }
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
    const selection = readSelection()
    const selectedText = selection?.toString() ?? ''
    if (!selectedText) {
      return
    }
    const range = getPierreSelectionRange(selection)
    if (!range) {
      return
    }
    const { relativePath, language } = getFileInfo()
    const formatted = formatCopiedSelectionWithContext({
      relativePath,
      language,
      selectedText,
      selection: range
    })
    if (!formatted) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const copiedSelection = selectionKey(selection)
    void window.api.ui
      .writeClipboardText(formatted)
      .then(() => {
        if (disposed) {
          return
        }
        lastCopiedSelection = copiedSelection
        hideHint()
        toast.success(
          translate('auto.components.editor.useContextualCopySetup.059bfb0d94', 'Context copied')
        )
      })
      .catch((error: unknown) => {
        console.error('Failed to copy diff context:', error)
      })
  }

  container.addEventListener('keydown', handleKeyDown, true)
  document.addEventListener('selectionchange', handleSelectionChange)
  document.addEventListener('scroll', hideHint, true)
  container.addEventListener('blur', hideHint, true)
  window.addEventListener('resize', hideHint)
  window.addEventListener('blur', hideHint)
  return () => {
    disposed = true
    container.removeEventListener('keydown', handleKeyDown, true)
    document.removeEventListener('selectionchange', handleSelectionChange)
    document.removeEventListener('scroll', hideHint, true)
    container.removeEventListener('blur', hideHint, true)
    window.removeEventListener('resize', hideHint)
    window.removeEventListener('blur', hideHint)
    if (primarySelectionTimer !== null) {
      window.clearTimeout(primarySelectionTimer)
    }
    hint.remove()
  }
}
