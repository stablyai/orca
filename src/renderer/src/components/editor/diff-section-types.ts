import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'

export type DiffSection = {
  key: string
  path: string
  status: string
  area?: GitStatusEntry['area']
  oldPath?: string
  added?: number
  removed?: number
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
  loadOnDemand?: boolean
  error?: string
  dirty: boolean
  /** A save was refused because disk changed since this section loaded. */
  saveConflict?: true
  diffResult: GitDiffResult | null
  largeDiffRenderLimit: LargeDiffRenderLimit | null
  // Why: combined sections keep Monaco models by path; bump on reload so
  // refetched git content does not replay through keepCurrent* model reuse.
  contentGeneration?: number
}
