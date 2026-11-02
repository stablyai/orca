import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { forgetCombinedDiffViewsShowingPath } from './combined-diff-view-cache'

// Module state retains toolbar choices across viewer unmounts within this session.
export const combinedDiffViewPreferences: {
  collapsed: boolean | null
  sideBySide: boolean | null
  fileTreeCollapsed: boolean | null
} = { collapsed: null, sideBySide: null, fileTreeCollapsed: null }

function handleCombinedDiffExternalFileChange(event: Event): void {
  const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
  if (detail?.relativePath) {
    // Inactive tabs are unmounted; invalidate their cached bodies before a remount can replay stale content.
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
  // Remove global listeners on HMR disposal so dev sessions cannot accumulate handlers.
  import.meta.hot.dispose(disposeCombinedDiffViewMemory)
}
