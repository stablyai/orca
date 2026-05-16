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
}
