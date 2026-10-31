import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import type { LargeDiffRenderLimit } from './large-diff-render-limit'
import type { acquireEditorFileOperation } from '@/lib/editor-file-operation-owner'

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
  operation?: ReturnType<typeof acquireEditorFileOperation>
  largeDiffRenderLimit: LargeDiffRenderLimit | null
  // Bump on refetch so path-owned retained Monaco models cannot replay old content.
  contentGeneration?: number
}
