import type { GitDiffResult, GitStatusEntry } from '../../../../shared/types'

export type DiffSection = {
  key: string
  path: string
  status: string
  area?: GitStatusEntry['area']
  oldPath?: string
  originalContent: string
  modifiedContent: string
  collapsed: boolean
  loading: boolean
  dirty: boolean
  diffResult: GitDiffResult | null
}
