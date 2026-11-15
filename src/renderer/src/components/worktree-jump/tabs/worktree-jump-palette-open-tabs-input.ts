import type { PaletteSearchContext } from '../../../../../shared/palette-match/palette-ranking'
import type { WorktreeJumpPaletteFilter } from '../results/use-worktree-jump-palette-filter'
import type { WorktreeJumpPaletteLocalState } from '../state/use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteStoreState } from '../state/use-worktree-jump-palette-store-state'
import type { WorktreeJumpPaletteWorktrees } from '../workspaces/use-worktree-jump-palette-worktrees'
import type { WorktreeJumpPaletteExtraResults } from '../results/use-worktree-jump-palette-extra-results'

export type WorktreeJumpPaletteOpenTabsInput = WorktreeJumpPaletteStoreState &
  WorktreeJumpPaletteWorktrees &
  Pick<WorktreeJumpPaletteFilter, 'repoMap' | 'repoByHostIdentity'> &
  Pick<WorktreeJumpPaletteLocalState, 'deferredQuery'> &
  Pick<WorktreeJumpPaletteExtraResults, 'hidesPaletteWorkspace'> & {
    paletteSearchContext: PaletteSearchContext
  }
