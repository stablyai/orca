import { runBuiltInOrReplacement } from '@/lib/plugins/commands/plugin-command-replacements'
import { useAppStore } from '@/store'

/** Main's history-chord path; false where it does nothing. */
export function navigateWorktreeHistoryFromShortcut(direction: 'back' | 'forward'): boolean {
  const store = useAppStore.getState()
  // Why: mirror button visibility — worktree history nav is only meaningful in the terminal view, so no-op elsewhere.
  if (store.activeView !== 'terminal') {
    return false
  }
  if (direction === 'back') {
    runBuiltInOrReplacement('worktree.history.back', () => store.goBackWorktree())
  } else {
    runBuiltInOrReplacement('worktree.history.forward', () => store.goForwardWorktree())
  }
  return true
}
