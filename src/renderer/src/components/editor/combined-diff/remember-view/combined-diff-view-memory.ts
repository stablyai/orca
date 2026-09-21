import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { DiffSection } from '../../diff-section-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'

export type CachedCombinedDiffViewState = {
  entrySignature: string
  gitStatusSignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
}

export const combinedDiffViewStateCache = new Map<string, CachedCombinedDiffViewState>()
export const combinedDiffScrollTopCache = new Map<string, number>()
export const combinedDiffScrollAnchorCache = new Map<string, VirtualizedScrollAnchor>()

// Why: session-scoped toolbar choices outlive the unmount, so they are module state rather than component state.
export const combinedDiffViewPreferences: {
  collapsed: boolean | null
  sideBySide: boolean | null
  fileTreeCollapsed: boolean | null
} = { collapsed: null, sideBySide: null, fileTreeCollapsed: null }

function invalidateCombinedDiffCachesForRelativePath(relativePath: string): void {
  for (const [key, cached] of combinedDiffViewStateCache.entries()) {
    if (cached.sections.some((section) => section.path === relativePath)) {
      combinedDiffViewStateCache.delete(key)
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, (event) => {
    const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
    if (detail?.relativePath) {
      // Why: inactive combined-diff tabs are unmounted, so only a module-level cache bust stops a remount replaying stale bodies.
      invalidateCombinedDiffCachesForRelativePath(detail.relativePath)
    }
  })
}
