import type { PRInfo } from '../../../../shared/types'

export type WorktreeCardPrDisplay =
  | PRInfo
  | {
      number: number
      title: string
      state?: PRInfo['state']
      url?: string
      checksStatus?: PRInfo['checksStatus']
    }

export function getWorktreeCardPrDisplay(
  pr: PRInfo | null | undefined,
  linkedPR: number | null
): WorktreeCardPrDisplay | null {
  if (pr) {
    return pr
  }

  if (linkedPR === null) {
    return null
  }

  return {
    number: linkedPR,
    // Why: linked PR metadata is persisted before GitHub details are cached.
    // Keep the row visible on cold first render while the PR lookup catches up.
    title: pr === null ? 'PR details unavailable' : 'Loading PR...'
  }
}
