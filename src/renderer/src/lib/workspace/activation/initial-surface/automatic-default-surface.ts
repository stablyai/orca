import { useAppStore } from '@/store'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { hasSplitLandingGroup } from '@/store/slices/tabs/split-landing-groups'

/** Automatic default-surface creation; a waiting split chooser is the surface the user left. Recovery inventory keeps the plain count. */
export function shouldSeedDefaultSurface(
  worktreeId: string,
  renderableTabCount: number,
  hasPersistedTerminalState = false
): boolean {
  return (
    shouldAutoCreateInitialTerminal(renderableTabCount, hasPersistedTerminalState) &&
    !hasSplitLandingGroup(useAppStore.getState(), worktreeId)
  )
}
