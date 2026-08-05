import { describe, expect, it } from 'vitest'
import {
  shouldShowCombinedDiffFileTreeHint,
  type CombinedDiffFileTreeHintVisibilityInput
} from './combined-diff-file-tree-hint-visibility'

function eligibleInput(
  overrides: Partial<CombinedDiffFileTreeHintVisibilityInput> = {}
): CombinedDiffFileTreeHintVisibilityInput {
  return {
    persistedUIReady: true,
    combinedDiffFileTreeHintDismissed: false,
    surfaceActive: true,
    fileTreeCollapsed: true,
    sectionsLoaded: true,
    changedFileCount: 3,
    combinedDiffFileTreeVisibleByDefault: false,
    fileTreeAlreadyUsed: false,
    activeContextualTourId: null,
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false,
    ...overrides
  }
}

describe('shouldShowCombinedDiffFileTreeHint', () => {
  it('shows the hint for an undiscovered file tree on a visible diff', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput())).toBe(true)
  })

  it('waits for persisted UI so a pre-hydration default cannot nag', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ persistedUIReady: false }))).toBe(
      false
    )
  })

  it('never re-arms once the hint has been shown', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(eligibleInput({ combinedDiffFileTreeHintDismissed: true }))
    ).toBe(false)
  })

  it('stays closed on a mounted but hidden surface', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ surfaceActive: false }))).toBe(false)
  })

  it('stays closed when the tree is already open', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ fileTreeCollapsed: false }))).toBe(
      false
    )
  })

  it('waits for the section list to settle', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ sectionsLoaded: false }))).toBe(false)
  })

  it('skips diffs too small to need a tree', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ changedFileCount: 2 }))).toBe(false)
  })

  it('skips users whose default already shows the tree', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(
        eligibleInput({ combinedDiffFileTreeVisibleByDefault: true })
      )
    ).toBe(false)
    expect(
      shouldShowCombinedDiffFileTreeHint(
        eligibleInput({ combinedDiffFileTreeVisibleByDefault: undefined })
      )
    ).toBe(true)
  })

  it('skips users who already toggled a diff file tree', () => {
    expect(shouldShowCombinedDiffFileTreeHint(eligibleInput({ fileTreeAlreadyUsed: true }))).toBe(
      false
    )
  })

  it('yields to a running contextual tour, which paints above this popover', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(
        eligibleInput({ activeContextualTourId: 'workspace-agent-sessions' })
      )
    ).toBe(false)
  })

  it('yields to contextual-tour onboarding', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(eligibleInput({ contextualToursOnboardingVisible: true }))
    ).toBe(false)
  })

  it('yields to a blocking surface', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(
        eligibleInput({ contextualToursBlockingSurfaceVisible: true })
      )
    ).toBe(false)
  })

  it('still shows once a tour has finished, since this hint is outside the tour budget', () => {
    expect(
      shouldShowCombinedDiffFileTreeHint(eligibleInput({ activeContextualTourId: null }))
    ).toBe(true)
  })
})
