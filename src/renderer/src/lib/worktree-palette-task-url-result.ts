import type { PaletteSearchResult, PaletteSupportingText } from './worktree-palette-search'
import type { Worktree } from '../../../shared/worktree/types'
import { createRecognizedPaletteRank } from './palette-match/palette-document'

const ACCESSIBILITY_LABELS: Record<PaletteSupportingText['labelKind'], string> = {
  comment: 'Workspace comment',
  automation: 'Created by automation',
  task: 'Linked task',
  pr: 'Pull request',
  mr: 'Merge request',
  issue: 'Linked issue',
  port: 'Listening port'
}

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
      accessibilityLabel: ACCESSIBILITY_LABELS[args.labelKind]
    },
    qualityClass: 'exact-intent',
    rank: createRecognizedPaletteRank(),
    lastActiveAt: null,
    activity: { ageBucket: null, timestamp: 0 }
  }
}
