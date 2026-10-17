import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { setWithLRU } from '@/lib/scroll-cache'
import type { DiffSection } from '../../diff-section-types'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '../../editor-autosave'
import { MAX_RENDERED_DIFF_COMBINED_CHARACTERS } from '../../large-diff-render-limit'

// Why: unmounted views keep every loaded file body here, so a count cap alone let 20 large diffs pin hundreds of MB.
export const COMBINED_DIFF_VIEW_CACHE_MAX_CHARS = MAX_RENDERED_DIFF_COMBINED_CHARACTERS * 4

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

// Why: scroll writes re-store the same sections array, so its weight is computed once per array.
const retainedCharsBySections = new WeakMap<DiffSection[], number>()

// File text the budget may drop. A view with unsaved edits weighs nothing: after unmount this cache
// is the only owner of those drafts, so the budget never evicts it (the count cap still applies).
function countEvictableChars(sections: DiffSection[]): number {
  const known = retainedCharsBySections.get(sections)
  if (known !== undefined) {
    return known
  }
  let chars = 0
  for (const section of sections) {
    if (section.dirty) {
      chars = 0
      break
    }
    chars += section.originalContent.length + section.modifiedContent.length
    const result = section.diffResult
    if (result && result.originalContent !== section.originalContent) {
      chars += result.originalContent.length
    }
    if (result && result.modifiedContent !== section.modifiedContent) {
      chars += result.modifiedContent.length
    }
  }
  retainedCharsBySections.set(sections, chars)
  return chars
}

export function rememberCombinedDiffViewState(
  viewStateKey: string,
  state: CachedCombinedDiffViewState
): void {
  // Why: refused before admission so a view that can never fit does not flush the views that do;
  // its older snapshot goes too, or a return would restore stale sections.
  if (countEvictableChars(state.sections) > COMBINED_DIFF_VIEW_CACHE_MAX_CHARS) {
    combinedDiffViewStateCache.delete(viewStateKey)
    return
  }
  setWithLRU(combinedDiffViewStateCache, viewStateKey, state)
  let total = 0
  for (const cached of combinedDiffViewStateCache.values()) {
    total += countEvictableChars(cached.sections)
  }
  for (const [key, cached] of combinedDiffViewStateCache) {
    if (total <= COMBINED_DIFF_VIEW_CACHE_MAX_CHARS) {
      break
    }
    const chars = countEvictableChars(cached.sections)
    if (key === viewStateKey || chars === 0) {
      continue
    }
    total -= chars
    combinedDiffViewStateCache.delete(key)
  }
}

function invalidateCombinedDiffCachesForRelativePath(relativePath: string): void {
  for (const [key, cached] of combinedDiffViewStateCache.entries()) {
    if (cached.sections.some((section) => section.path === relativePath)) {
      combinedDiffViewStateCache.delete(key)
    }
  }
}

function handleCombinedDiffExternalFileChange(event: Event): void {
  const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
  if (detail?.relativePath) {
    // Why: inactive combined-diff tabs are unmounted, so only a module-level cache bust stops a remount replaying stale bodies.
    invalidateCombinedDiffCachesForRelativePath(detail.relativePath)
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
