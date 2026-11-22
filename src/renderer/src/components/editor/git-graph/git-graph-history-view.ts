import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'

export type GitGraphHistoryView = {
  result?: GitHistoryResult
  error?: string
  loading: boolean
  selectedId?: string
  revealId?: string
}
