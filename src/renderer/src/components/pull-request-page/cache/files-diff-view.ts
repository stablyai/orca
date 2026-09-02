import type { DiffSection } from '@/components/editor/diff-section-types'

export type CachedPRFilesDiffViewState = {
  entrySignature: string
  sections: DiffSection[]
  sectionHeights: Record<number, number>
  loadedIndices: number[]
  scrollTop: number
  sideBySide: boolean
  fileTreeCollapsed: boolean
  activeTreeSectionKey: string | null
}

export const prFilesDiffViewStateCache = new Map<string, CachedPRFilesDiffViewState>()
export const prFilesDiffScrollTopCache = new Map<string, number>()
