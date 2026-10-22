import { compareCmdJTranscriptRankedItems } from '@/lib/cmd-j-transcript-ranking'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import type { WorktreePaletteItem } from './worktree-jump-palette-model'

export function buildWorktreePaletteItems({
  hasQuery,
  worktreeMatches,
  resolveWorktree
}: Pick<
  WorktreeJumpPaletteWorktrees,
  'hasQuery' | 'worktreeMatches' | 'resolveWorktree'
>): WorktreePaletteItem[] {
  const items = worktreeMatches
    .map((match) => {
      const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
      return worktree
        ? {
            id: encodePaletteIdentity(['worktree', getPaletteWorktreeIdentity(worktree)]),
            type: 'worktree' as const,
            match,
            worktree
          }
        : null
    })
    .filter((item): item is WorktreePaletteItem => item !== null)
  if (!hasQuery) {
    return items
  }
  const orderByIdentity = new Map(
    items.map((item, index) => [getPaletteWorktreeIdentity(item.worktree), index])
  )
  return items.sort((left, right) =>
    compareCmdJTranscriptRankedItems(
      {
        rank: left.match.rank,
        qualityClass: left.match.qualityClass,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(left.worktree)) ?? 0,
        identity: left.id,
        activity: left.match.activity
      },
      {
        rank: right.match.rank,
        qualityClass: right.match.qualityClass,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(right.worktree)) ?? 0,
        identity: right.id,
        activity: right.match.activity
      }
    )
  )
}
