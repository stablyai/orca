import type { DiffReadingAnchor } from '@/components/editor/combined-diff/scroll-viewport/combined-diff-layout'
import type { DiffSection } from '@/components/editor/diff/sections/diff-section-types'

export type CachedPRFilesDiffViewState = {
  entrySignature: string
  sections: DiffSection[]
  sectionHeights: Record<string, number>
  loadedIndices: number[]
  scrollAnchor: DiffReadingAnchor | null
  sideBySide: boolean
  fileTreeCollapsed: boolean
  activeTreeSectionKey: string | null
}

export const prFilesDiffViewStateCache = new Map<string, CachedPRFilesDiffViewState>()
