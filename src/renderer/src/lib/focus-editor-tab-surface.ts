import {
  beginActiveSurfaceFocus,
  isActiveSurfaceFocusCurrent
} from '@/lib/active-surface-focus-generation'

/**
 * Move keyboard focus into the editor surface for a freshly-activated editor
 * tab. Parallels focus-terminal-tab-surface, but editors need extra care:
 *  - Monaco is lazy-loaded behind Suspense, so on a cold tab its DOM is not
 *    present within a frame or two — we retry across a short frame budget.
 *  - Inactive workspaces stay mounted but display:none, so a background
 *    workspace's editor input is still in the DOM; focusing it is a silent
 *    no-op. We skip any surface that is not laid out (zero client rects, i.e.
 *    display:none) so focus lands on the destination workspace's visible
 *    editor — never a hidden one, and never a terminal.
 */
// Monaco 0.52+ swaps the editing textarea for a focusable `.native-edit-context`
// div (Electron always has EditContext); never target the bare `textarea`, which
// also matches Monaco's tabindex=-1 `.ime-text-area`. The editable markdown
// selector is shell-scoped because the bare `.rich-markdown-editor` class is also
// worn by the GitHub/Linear comment composers; `.markdown-preview` is read-only,
// so it stays unscoped.
const EDITOR_FOCUS_SELECTORS = [
  '.monaco-editor .native-edit-context',
  '.monaco-editor textarea.inputarea',
  '.rich-markdown-editor-shell .rich-markdown-editor[contenteditable="true"]',
  '.markdown-preview'
]

// Why: an inline tab rename mounts its own input; if a queued focus frame runs
// while it is open, focusing the editor blurs the input and commits the rename
// closed. Parallels the guard in focus-terminal-tab-surface (same shared marker,
// worn by both terminal and editor tabs).
const TAB_RENAME_INPUT_SELECTOR = '[data-tab-rename-input="true"]'

// ~0.5s at 60fps: long enough to cover the lazy Monaco chunk mounting on a cold
// tab, short enough that a stale request never fights a newer navigation.
const MAX_FOCUS_ATTEMPTS = 30

let pendingFocusFrameId: number | null = null

function cancelPendingFocusFrame(): void {
  if (pendingFocusFrameId !== null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(pendingFocusFrameId)
  }
  pendingFocusFrameId = null
}

function isLaidOut(element: HTMLElement): boolean {
  // display:none (an inactive, warm workspace) yields zero client rects; a
  // visible editor — even Monaco's zero-size hidden input — yields at least one.
  return element.getClientRects().length > 0
}

function isReadOnlyDiffOriginal(element: HTMLElement): boolean {
  // Why: Monaco renders a diff as two editors — `.editor.original` (left,
  // read-only "before") and `.editor.modified` (right, editable "after"). Both
  // expose a laid-out `.native-edit-context` and the original comes first in the
  // DOM, so a naive first-match parks the caret on the read-only side and typing
  // goes nowhere. Skip it so focus lands on the editable modified pane.
  return element.closest('.editor.original') !== null
}

function focusVisibleEditorSurface(): boolean {
  for (const selector of EDITOR_FOCUS_SELECTORS) {
    const candidates = document.querySelectorAll(selector)
    for (let index = 0; index < candidates.length; index++) {
      const element = candidates.item(index) as HTMLElement | null
      if (!element || !isLaidOut(element) || isReadOnlyDiffOriginal(element)) {
        continue
      }
      element.focus()
      if (document.activeElement === element || element.contains(document.activeElement)) {
        return true
      }
    }
  }
  return false
}

export function focusEditorTabSurface(): void {
  cancelPendingFocusFrame()
  const token = beginActiveSurfaceFocus()
  let attempts = 0
  const attempt = (): void => {
    pendingFocusFrameId = null
    // Bail if a newer navigation (terminal/editor/fallback) has superseded us —
    // otherwise this stale loop could steal focus from the newer destination.
    if (!isActiveSurfaceFocusCurrent(token)) {
      return
    }
    // Don't fight an open inline tab rename; focusing would blur-commit it.
    if (document.querySelector(TAB_RENAME_INPUT_SELECTOR)) {
      return
    }
    if (focusVisibleEditorSurface()) {
      return
    }
    attempts += 1
    if (attempts < MAX_FOCUS_ATTEMPTS) {
      pendingFocusFrameId = requestAnimationFrame(attempt)
    }
  }
  pendingFocusFrameId = requestAnimationFrame(attempt)
}
