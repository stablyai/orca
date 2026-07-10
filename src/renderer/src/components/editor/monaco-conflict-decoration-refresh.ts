import type { editor } from 'monaco-editor'
import { buildGitConflictDecorations, hasGitConflictMarkers } from './monaco-conflict-decorations'

export const GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS = 120

export type GitConflictDecorationRefresher = {
  refresh: (content: string, options?: { immediate?: boolean }) => void
  clear: () => void
  dispose: () => void
}

export function createGitConflictDecorationRefresher(
  editorInstance: editor.IStandaloneCodeEditor
): GitConflictDecorationRefresher {
  let collection: editor.IEditorDecorationsCollection | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let lastScannedContent: string | null = null

  const cancelPendingRefresh = (): void => {
    if (refreshTimer === null) {
      return
    }
    clearTimeout(refreshTimer)
    refreshTimer = null
  }

  const applyNow = (content: string): void => {
    cancelPendingRefresh()
    lastScannedContent = content
    if (!hasGitConflictMarkers(content)) {
      collection?.clear()
      return
    }
    const decorations = buildGitConflictDecorations(content)
    if (!collection) {
      collection = editorInstance.createDecorationsCollection(decorations)
      return
    }
    collection.set(decorations)
  }

  const refresh = (content: string, options?: { immediate?: boolean }): void => {
    if (content === lastScannedContent) {
      // Why: decorations already reflect this content; a pending rescan for
      // superseded text (e.g. undo back to the applied state) must not fire.
      cancelPendingRefresh()
      return
    }
    if (options?.immediate || lastScannedContent === null) {
      applyNow(content)
      return
    }
    cancelPendingRefresh()
    // Why: controlled `content` changes on every keystroke; coalescing avoids a
    // full conflict re-parse per key. One rebuild lands after typing settles.
    refreshTimer = setTimeout(() => applyNow(content), GIT_CONFLICT_DECORATION_REFRESH_DELAY_MS)
  }

  const clear = (): void => {
    cancelPendingRefresh()
    // Why: resetting the gate makes the next enabled refresh scan immediately
    // instead of debouncing behind stale "already scanned" state.
    lastScannedContent = null
    collection?.clear()
  }

  return {
    refresh,
    clear,
    dispose: () => {
      clear()
      collection = null
    }
  }
}
