import { useCallback, useMemo } from 'react'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { cmdJEffectiveQualityRank } from '@/lib/cmd-j-transcript-ranking'
import { observedPaletteSectionKeys } from './cmd-j/palette-observed-prefix'
import type { WorktreeJumpPaletteObservedPrefix } from './use-worktree-jump-palette-observed-prefix'
import { bestCmdJPaletteSectionQualityClass } from '@/components/cmd-j/palette-results'
import {
  bestPaletteQualityRank,
  NO_PALETTE_QUALITY_RANK,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections
} from '@/lib/cmd-j-section-leadership'
import {
  capPaletteSection,
  reserveObservedPaletteSection,
  layoutMultiPrimaryPaletteSections,
  PALETTE_SECTION_EXPAND_STEP,
  PALETTE_SECTION_RENDER_CAP,
  TYPED_QUERY_LEADING_PREVIEW
} from '@/components/cmd-j/palette-section-render-cap'
import {
  DIGIT_INDEX_ACTION_ID,
  DIGIT_INDEX_ADDRESSABLE_ROWS,
  EMPTY_QUERY_RECENT_TAB_CAP,
  EMPTY_QUERY_ROW_BUDGET,
  EMPTY_QUERY_WORKTREE_CAP,
  type OpenTabPaletteItem,
  type PaletteItem,
  type WorktreePaletteItem
} from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteLocalState } from './use-worktree-jump-palette-local-state'
import type { WorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import type { WorktreeJumpPaletteProjectTargets } from './use-worktree-jump-palette-project-targets'
import type { WorktreeJumpPaletteQuickActions } from './use-worktree-jump-palette-quick-actions'
import type { WorktreeJumpPaletteRecentTabs } from './use-worktree-jump-palette-recent-tabs'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'

const paletteItemIdentity = (item: { id: string }): string => item.id

type WorktreeJumpPaletteSectionsInput = WorktreeJumpPaletteOpenTabs &
  Pick<WorktreeJumpPaletteObservedPrefix, 'protectedOccurrences' | 'resetPresentation'> &
  WorktreeJumpPaletteRecentTabs &
  WorktreeJumpPaletteProjectTargets &
  Pick<WorktreeJumpPaletteQuickActions, 'middleItems'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> &
  Pick<
    WorktreeJumpPaletteLocalState,
    'createWorktreeName' | 'showCreateAction' | 'expandedSectionCaps' | 'setExpandedSectionCaps'
  >

export function useWorktreeJumpPaletteSections({
  hasQuery,
  worktreeItems: rankedWorktreeItems,
  openTabItems: rankedOpenTabItems,
  recentTabItems,
  projectTargetItems: rankedProjectTargetItems,
  middleItems: rankedMiddleItems,
  createWorktreeName,
  showCreateAction,
  expandedSectionCaps,
  setExpandedSectionCaps,
  protectedOccurrences,
  resetPresentation
}: WorktreeJumpPaletteSectionsInput) {
  const worktreeItems = useMemo(
    () =>
      reserveObservedPaletteSection(
        rankedWorktreeItems,
        observedPaletteSectionKeys(protectedOccurrences, 'worktrees')
      ),
    [rankedWorktreeItems, protectedOccurrences]
  )
  const openTabItems = useMemo(
    () =>
      reserveObservedPaletteSection(
        rankedOpenTabItems,
        observedPaletteSectionKeys(protectedOccurrences, 'open-tabs')
      ),
    [rankedOpenTabItems, protectedOccurrences]
  )
  const projectTargetItems = useMemo(
    () =>
      reserveObservedPaletteSection(
        rankedProjectTargetItems,
        observedPaletteSectionKeys(protectedOccurrences, 'projects')
      ),
    [rankedProjectTargetItems, protectedOccurrences]
  )
  const middleItems = useMemo(
    () =>
      reserveObservedPaletteSection(
        rankedMiddleItems,
        observedPaletteSectionKeys(protectedOccurrences, 'middle')
      ),
    [rankedMiddleItems, protectedOccurrences]
  )
  const { openTabsLeadSections, middleLeadsSections } = useMemo(() => {
    if (!hasQuery) {
      return { openTabsLeadSections: true, middleLeadsSections: false }
    }
    const bestWorktreeQualityRank = bestPaletteQualityRank(
      worktreeItems.map((item) => item.match.qualityClass)
    )
    const bestOpenTabQualityRank = openTabItems.reduce(
      (best, item) =>
        Math.min(
          best,
          cmdJEffectiveQualityRank(
            item.result.qualityClass,
            item.type === 'workspace-tab' && item.transcript?.complete
          )
        ),
      NO_PALETTE_QUALITY_RANK
    )
    return {
      openTabsLeadSections: shouldOpenTabsLeadPaletteSections({
        bestWorktreeQualityRank,
        bestOpenTabQualityRank
      }),
      middleLeadsSections: shouldIntentSectionLeadPaletteSections({
        bestEntityQualityRank: Math.min(bestWorktreeQualityRank, bestOpenTabQualityRank),
        bestIntentQualityRank: bestPaletteQualityRank([
          bestCmdJPaletteSectionQualityClass(middleItems.map((item) => item.result)),
          bestCmdJPaletteSectionQualityClass(projectTargetItems.map((item) => item.result))
        ])
      })
    }
  }, [hasQuery, middleItems, openTabItems, projectTargetItems, worktreeItems])

  const handleExpandSection = useCallback(
    (sectionKey: string) => {
      resetPresentation()
      setExpandedSectionCaps((previous) => ({
        ...previous,
        [sectionKey]: (previous[sectionKey] ?? 0) + PALETTE_SECTION_EXPAND_STEP
      }))
    },
    [resetPresentation, setExpandedSectionCaps]
  )

  const openTabsCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['open-tabs'] ?? 0)
  const typedWorktreeCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.worktrees ?? 0)
  const paletteSections = useMemo(() => {
    // Why: "See more" drops the above-the-fold trim outright instead of stepping 20 at a time, so one
    // click reveals the whole recent history the shared render cap allows.
    const recentTabsCap = expandedSectionCaps['open-tabs']
      ? openTabsCap
      : EMPTY_QUERY_RECENT_TAB_CAP
    const openTabs = hasQuery
      ? capPaletteSection(openTabItems, openTabsCap, undefined, paletteItemIdentity)
      : capPaletteSection(recentTabItems, recentTabsCap)
    const baseWorktreeCap = hasQuery
      ? Infinity
      : Math.min(
          openTabs.visible.length === 0 ? EMPTY_QUERY_ROW_BUDGET : EMPTY_QUERY_WORKTREE_CAP,
          Math.max(1, EMPTY_QUERY_ROW_BUDGET - openTabs.visible.length)
        )
    const worktreeCap = hasQuery
      ? typedWorktreeCap
      : baseWorktreeCap + (expandedSectionCaps.worktrees ?? 0)
    const worktrees = hasQuery
      ? capPaletteSection(worktreeItems, worktreeCap, undefined, paletteItemIdentity)
      : {
          visible: worktreeItems.slice(0, worktreeCap),
          overflowCount: Math.max(0, worktreeItems.length - worktreeCap)
        }
    const projectTargets = capPaletteSection(
      hasQuery ? projectTargetItems : [],
      PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.projects ?? 0),
      undefined,
      paletteItemIdentity
    )
    const middle = capPaletteSection(
      hasQuery ? middleItems : [],
      PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.middle ?? 0),
      undefined,
      paletteItemIdentity
    )
    const multiPrimaryFirstScreen =
      hasQuery && openTabs.visible.length > 0 && worktrees.visible.length > 0
    const multiPrimaryLayout = multiPrimaryFirstScreen
      ? layoutMultiPrimaryPaletteSections<WorktreePaletteItem | OpenTabPaletteItem>({
          leadingItems: openTabsLeadSections ? openTabItems : worktreeItems,
          trailingItems: openTabsLeadSections ? worktreeItems : openTabItems,
          leadingPreviewCount:
            TYPED_QUERY_LEADING_PREVIEW +
            (expandedSectionCaps[openTabsLeadSections ? 'open-tabs' : 'worktrees'] ?? 0),
          leadingHardCap: openTabsLeadSections ? openTabsCap : worktreeCap,
          trailingHardCap: openTabsLeadSections ? worktreeCap : openTabsCap,
          identity: paletteItemIdentity
        })
      : null
    return {
      availableItems: [...openTabItems, ...worktreeItems, ...projectTargetItems, ...middleItems],
      // Whole-field equality outranks website navigation; exact words alone do not.
      hasExactEntityDestination:
        worktreeItems.some((item) => (item.match.rank?.destination ?? 3) <= 1) ||
        openTabItems.some((item) => (item.result.rank?.destination ?? 3) <= 1),
      visibleWorktreeItems: worktrees.visible as PaletteItem[],
      worktreeOverflowCount: worktrees.overflowCount,
      visibleProjectTargetItems: projectTargets.visible as PaletteItem[],
      projectTargetOverflowCount: projectTargets.overflowCount,
      visibleMiddleItems: middle.visible as PaletteItem[],
      middleOverflowCount: middle.overflowCount,
      visibleOpenTabItems: openTabs.visible as PaletteItem[],
      openTabOverflowCount: openTabs.overflowCount,
      multiPrimaryFirstScreen,
      multiPrimaryLayout
    }
  }, [
    expandedSectionCaps,
    hasQuery,
    middleItems,
    openTabItems,
    openTabsLeadSections,
    openTabsCap,
    projectTargetItems,
    recentTabItems,
    typedWorktreeCap,
    worktreeItems
  ])

  // Why: badges number the snapshotted recent rows only — ⌘N is meaningless on a typed query, and an
  // expanded section leaves its unaddressable rows unbadged rather than advertising ⌘10.
  const recentTabShortcutIndexByItem = useMemo(
    () =>
      new Map(
        hasQuery
          ? []
          : paletteSections.visibleOpenTabItems
              .slice(0, DIGIT_INDEX_ADDRESSABLE_ROWS)
              .map((item, index) => [item, index])
      ),
    [hasQuery, paletteSections]
  )
  const recentTabShortcutIndexById = useMemo(
    () =>
      new Map(
        hasQuery
          ? []
          : paletteSections.visibleOpenTabItems
              .slice(0, DIGIT_INDEX_ADDRESSABLE_ROWS)
              .map((item, index) => [item.id, index])
      ),
    [hasQuery, paletteSections]
  )
  const digitShortcutModifiers =
    useShortcutKeyComboDetails(DIGIT_INDEX_ACTION_ID)[0]?.keys.slice(0, -1) ?? []

  return {
    openTabsLeadSections,
    middleLeadsSections,
    paletteSections,
    recentTabShortcutIndexByItem,
    recentTabShortcutIndexById,
    digitShortcutModifiers,
    createWorktreeName,
    showCreateAction,
    handleExpandSection
  }
}

export type WorktreeJumpPaletteSections = ReturnType<typeof useWorktreeJumpPaletteSections>
