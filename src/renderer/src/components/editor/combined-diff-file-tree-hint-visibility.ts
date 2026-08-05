// Below this, scrolling the diff is fine and the tree is not worth interrupting for.
export const COMBINED_DIFF_FILE_TREE_HINT_MIN_CHANGED_FILES = 3

export type CombinedDiffFileTreeHintVisibilityInput = {
  persistedUIReady: boolean
  combinedDiffFileTreeHintDismissed: boolean
  surfaceActive: boolean
  fileTreeCollapsed: boolean
  sectionsLoaded: boolean
  changedFileCount: number
  combinedDiffFileTreeVisibleByDefault: boolean | undefined
  fileTreeAlreadyUsed: boolean
  activeContextualTourId: string | null
  contextualToursOnboardingVisible: boolean
  contextualToursBlockingSurfaceVisible: boolean
}

export function shouldShowCombinedDiffFileTreeHint({
  persistedUIReady,
  combinedDiffFileTreeHintDismissed,
  surfaceActive,
  fileTreeCollapsed,
  sectionsLoaded,
  changedFileCount,
  combinedDiffFileTreeVisibleByDefault,
  fileTreeAlreadyUsed,
  activeContextualTourId,
  contextualToursOnboardingVisible,
  contextualToursBlockingSurfaceVisible
}: CombinedDiffFileTreeHintVisibilityInput): boolean {
  return (
    persistedUIReady &&
    !combinedDiffFileTreeHintDismissed &&
    // Why: this popover sits at z-60, under the tour scrim (z-70) and panel (z-80), so a
    // callout fired mid-tour would be buried; onboarding and blocking surfaces own the
    // screen for the same reason. Deliberately NOT gated on contextualTourShownThisSession:
    // this hint is outside the tour budget, and one unrelated tour would mute it all session.
    activeContextualTourId === null &&
    !contextualToursOnboardingVisible &&
    !contextualToursBlockingSurfaceVisible &&
    // Why: hidden worktrees keep this viewer mounted, and a popover anchored to an
    // offscreen trigger lands at the viewport origin.
    surfaceActive &&
    fileTreeCollapsed &&
    // Why: the section list is rebuilt asynchronously, so an unsettled list would
    // judge the file count against a stale or empty diff.
    sectionsLoaded &&
    changedFileCount >= COMBINED_DIFF_FILE_TREE_HINT_MIN_CHANGED_FILES &&
    // Why: an explicit "shown" default means the user already knows the tree exists.
    combinedDiffFileTreeVisibleByDefault !== true &&
    !fileTreeAlreadyUsed
  )
}
