import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRReadMark } from '../pr-read-state'
import { adoptablePRs, clearPRRowsRead, markPRRowsRead } from '../pr-read-state'
import type { UISliceGet, UISliceSet } from './ui-slice-contract'

type PRReadActions = {
  /** Per-PR read marks; a PR is read while its mark still matches the row. */
  prReadMarks: Record<string, PRReadMark>
  markPRsRead: (items: readonly GitHubWorkItem[]) => void
  markPRsUnread: (items: readonly GitHubWorkItem[]) => void
  /** Stamps only PRs with no mark yet: adopting an existing list must never bury activity it already carries. */
  adoptPRsAsRead: (items: readonly GitHubWorkItem[]) => void
}

export function createUiPRReadActions(set: UISliceSet, get: UISliceGet): PRReadActions {
  return {
    prReadMarks: {},
    markPRsRead: (items) =>
      set((s) => {
        const prReadMarks = markPRRowsRead(s.prReadMarks, items)
        return prReadMarks === s.prReadMarks ? s : { prReadMarks }
      }),
    markPRsUnread: (items) =>
      set((s) => {
        const prReadMarks = clearPRRowsRead(s.prReadMarks, items)
        return prReadMarks === s.prReadMarks ? s : { prReadMarks }
      }),
    adoptPRsAsRead: (items) => {
      const unmarked = adoptablePRs(get().prReadMarks, items)
      if (unmarked.length > 0) {
        set((s) => ({ prReadMarks: markPRRowsRead(s.prReadMarks, unmarked) }))
      }
    }
  }
}
