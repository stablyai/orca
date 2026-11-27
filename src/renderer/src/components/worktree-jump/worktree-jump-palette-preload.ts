import { lazyWithPreload } from '@/app-shell/startup/lazy-with-retry'
import { usePreloadAfterInputQuiet } from '@/app-shell/startup/use-preload-after-input-quiet'

export const WorktreeJumpPalette = lazyWithPreload(() => import('./WorktreeJumpPalette'))

/** Loads the Cmd+J palette after startup settles so its first open renders without suspending. */
export function usePreloadWorktreeJumpPalette(): void {
  usePreloadAfterInputQuiet(WorktreeJumpPalette.preload)
}
