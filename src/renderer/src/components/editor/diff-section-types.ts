import type { GitDiffResult, GitStatusEntry } from '../../../../shared/types'

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
  error?: string
  dirty: boolean
  diffResult: GitDiffResult | null
  // Why: combined sections keep Monaco models by path; bump on reload so
  // refetched git content does not replay through keepCurrent* model reuse.
  contentGeneration?: number
}
