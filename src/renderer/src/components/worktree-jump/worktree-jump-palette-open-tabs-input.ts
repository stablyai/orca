import type { PaletteSearchContext } from '../../../../shared/palette-match/palette-ranking'
import type { WorktreeJumpPaletteFilter } from './use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

export type WorktreeJumpPaletteOpenTabsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteWorktrees &
  Pick<WorktreeJumpPaletteFilter, 'repoMap' | 'repoByHostIdentity'> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery'> & {
    paletteSearchContext: PaletteSearchContext
  }
