import type { PaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'

export type WorktreeJumpPaletteWorktreesInput = WorktreeJumpPaletteStoreState &
  Pick<
    WorktreeJumpPaletteFilter,
    'filterPredicate' | 'repoMap' | 'repoByHostIdentity' | 'hostOptions' | 'hostFilterActive'
  > &
  Pick<WorktreeJumpPaletteLocalState, 'paletteSearchQuery'> & {
    paletteSearchContext: PaletteSearchContext
  }
