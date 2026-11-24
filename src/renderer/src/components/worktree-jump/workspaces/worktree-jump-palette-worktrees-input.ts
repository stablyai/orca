import type { PaletteSearchContext } from '../../../../../shared/palette-match/palette-ranking'
import type { WorktreeJumpPaletteFilter } from '../results/use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from '../state/use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from '../state/use-worktree-jump-palette-store-state'

export type WorktreeJumpPaletteWorktreesInput = WorktreeJumpPaletteStoreState &
  Pick<
    WorktreeJumpPaletteFilter,
    | 'filterPredicate'
    | 'repoMap'
    | 'repoByHostIdentity'
    | 'hostOptions'
    | 'hostFilterActive'
    | 'defaultHostId'
  > &
  Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery'> & {
    paletteSearchContext: PaletteSearchContext
  }
