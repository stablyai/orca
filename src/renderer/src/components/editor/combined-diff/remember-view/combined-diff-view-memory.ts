import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { forgetCombinedDiffViewsShowingPath } from './combined-diff-view-cache'

// Why: session-scoped toolbar choices outlive the unmount, so they are module state rather than component state.
export const combinedDiffViewPreferences: {
  collapsed: boolean | null
  sideBySide: boolean | null
  fileTreeCollapsed: boolean | null
} = { collapsed: null, sideBySide: null, fileTreeCollapsed: null }

function handleCombinedDiffExternalFileChange(event: Event): void {
  const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
  if (detail?.relativePath) {
    // Why: inactive combined-diff tabs are unmounted, so only a module-level cache bust stops a remount replaying stale bodies.
    forgetCombinedDiffViewsShowingPath(detail.relativePath)
  }
}

export function disposeCombinedDiffViewMemory(): void {
  if (typeof window !== 'undefined') {
    window.removeEventListener(
      ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
      handleCombinedDiffExternalFileChange
    )
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
    handleCombinedDiffExternalFileChange
  )
}

if (import.meta !== undefined && import.meta.hot) {
  // Vite can replace this module without a full renderer reload. Remove the
  // global cache-bust listener so dev sessions do not accumulate handlers.
  import.meta.hot.dispose(disposeCombinedDiffViewMemory)
}
