import type { PaletteSearchResult, PaletteSupportingText } from './worktree-palette-search'
import type { Worktree } from '../../../shared/worktree/types'
import { getPaletteSupportingAccessibilityLabel } from './worktree-palette-evidence'
import { createRecognizedPaletteRank } from '../../../shared/palette-match/palette-document'

/**
 * A pasted task URL is a recognized exact intent, so its rows lead every section
 * and the whole identifier is highlighted as the proof.
 */
export function buildWorktreePaletteTaskUrlResult(args: {
  worktreeId: string
  worktreeHostId?: Worktree['hostId']
  labelKind: PaletteSupportingText['labelKind']
  text: string
}): PaletteSearchResult {
  return {
    worktreeId: args.worktreeId,
    ...(args.worktreeHostId ? { worktreeHostId: args.worktreeHostId } : {}),
    matchedFields: [args.labelKind],
    displayNameRanges: [],
    branchRanges: [],
    repoRanges: [],
    hostRanges: [],
    supportingText: {
      labelKind: args.labelKind,
      text: args.text,
      matchRanges: [{ start: 0, end: args.text.length }],
      accessibilityLabel: getPaletteSupportingAccessibilityLabel(args.labelKind)
    },
    qualityClass: 'exact-intent',
    rank: createRecognizedPaletteRank(),
    lastActiveAt: null,
    activity: { ageBucket: null, timestamp: 0 }
  }
}
