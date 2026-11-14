import { useCallback, useMemo } from 'react'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { bestCmdJPaletteSectionQualityClass } from '@/components/cmd-j/palette-results'
import {
  bestPaletteQualityRank,
  shouldExtraSectionLeadPaletteSections,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections
} from '@/lib/workspace/search/palette/cmd-j-section-leadership'
import {
  capPaletteSection,
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
import type { VisiblePaletteExtraSection } from './worktree-jump-palette-extra-list-entries'
import type { WorktreeJumpPaletteExtraResults } from './use-worktree-jump-palette-extra-results'

type WorktreeJumpPaletteSectionsInput = WorktreeJumpPaletteOpenTabs &
  WorktreeJumpPaletteRecentTabs &
  WorktreeJumpPaletteProjectTargets &
  Pick<WorktreeJumpPaletteQuickActions, 'middleItems'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> &
  Pick<WorktreeJumpPaletteExtraResults, 'extraSections'> &
  Pick<
    WorktreeJumpPaletteLocalState,
    | 'createWorktreeName'
    | 'showCreateAction'
    | 'expandedSectionCaps'
    | 'setExpandedSectionCaps'
    | 'selectedItemId'
  >

export function useWorktreeJumpPaletteSections({
  hasQuery,
  worktreeItems,
  openTabItems,
  recentTabItems,
  projectTargetItems,
  middleItems,
  extraSections,
  createWorktreeName,
  showCreateAction,
  expandedSectionCaps,
  setExpandedSectionCaps,
  selectedItemId
}: WorktreeJumpPaletteSectionsInput) {
  const openTabsLeadSections = useMemo(() => {
    if (!hasQuery) {
      return true
    }
    return shouldOpenTabsLeadPaletteSections({
      bestWorktreeQualityRank: bestPaletteQualityRank(
        worktreeItems.map((item) => item.match.qualityClass)
      ),
      bestOpenTabQualityRank: bestPaletteQualityRank(
        openTabItems.map((item) => item.result.qualityClass)
      )
    })
  }, [hasQuery, openTabItems, worktreeItems])

  const bestWorkspaceOrTabQualityRank = useMemo(
    () =>
      Math.min(
        bestPaletteQualityRank(worktreeItems.map((item) => item.match.qualityClass)),
        bestPaletteQualityRank(openTabItems.map((item) => item.result.qualityClass))
      ),
    [openTabItems, worktreeItems]
  )

  const middleLeadsSections = useMemo(() => {
    if (!hasQuery) {
      return false
    }
    const bestEntityQualityRank = Math.min(
      bestWorkspaceOrTabQualityRank,
      bestPaletteQualityRank(
        extraSections.flatMap((section) => section.items.map((item) => item.result.qualityClass))
      )
    )
    return shouldIntentSectionLeadPaletteSections({
      bestEntityQualityRank,
      bestIntentQualityRank: bestPaletteQualityRank([
        bestCmdJPaletteSectionQualityClass(middleItems.map((item) => item.result)),
        bestCmdJPaletteSectionQualityClass(projectTargetItems.map((item) => item.result))
      ])
    })
  }, [bestWorkspaceOrTabQualityRank, extraSections, hasQuery, middleItems, projectTargetItems])

  const handleExpandSection = useCallback(
    (sectionKey: string) => {
      setExpandedSectionCaps((previous) => ({
        ...previous,
        [sectionKey]: (previous[sectionKey] ?? 0) + PALETTE_SECTION_EXPAND_STEP
      }))
    },
    [setExpandedSectionCaps]
  )

  const openTabsCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps['open-tabs'] ?? 0)
  const typedWorktreeCap = PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.worktrees ?? 0)
  const openTabIndexById = useMemo(
    () => new Map(openTabItems.map((item, index) => [item.id, index])),
    [openTabItems]
  )
  const worktreeIndexById = useMemo(
    () => new Map(worktreeItems.map((item, index) => [item.id, index])),
    [worktreeItems]
  )
  const retainedOpenTabId =
    hasQuery && (openTabIndexById.get(selectedItemId ?? '') ?? -1) >= openTabsCap
      ? selectedItemId
      : null
  const retainedWorktreeId =
    hasQuery && (worktreeIndexById.get(selectedItemId ?? '') ?? -1) >= typedWorktreeCap
      ? selectedItemId
      : null

  const paletteSections = useMemo(() => {
    const retainOpenTab = (item: { id: string }): boolean => item.id === retainedOpenTabId
    const retainWorktree = (item: { id: string }): boolean => item.id === retainedWorktreeId
    // See more removes the trim in one step, up to the shared render cap.
    const recentTabsCap = expandedSectionCaps['open-tabs']
      ? openTabsCap
      : EMPTY_QUERY_RECENT_TAB_CAP
    const openTabs = hasQuery
      ? capPaletteSection(openTabItems, openTabsCap, retainOpenTab)
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
      ? capPaletteSection(worktreeItems, worktreeCap, retainWorktree)
      : {
          visible: worktreeItems.slice(0, worktreeCap),
          overflowCount: Math.max(0, worktreeItems.length - worktreeCap)
        }
    const projectTargets = capPaletteSection(
      hasQuery ? projectTargetItems : [],
      PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.projects ?? 0)
    )
    const middle = capPaletteSection(
      hasQuery ? middleItems : [],
      PALETTE_SECTION_RENDER_CAP + (expandedSectionCaps.middle ?? 0)
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
          leadingRetain: openTabsLeadSections ? retainOpenTab : retainWorktree,
          trailingRetain: openTabsLeadSections ? retainWorktree : retainOpenTab
        })
      : null
    return {
      // Whole-field equality outranks website navigation; exact words alone do not.
      hasExactEntityDestination:
        worktreeItems.some((item) => (item.match.rank?.destination ?? 3) <= 1) ||
        openTabItems.some((item) => (item.result.rank?.destination ?? 3) <= 1) ||
        extraSections.some((section) =>
          section.items.some((item) => (item.result.rank?.destination ?? 3) <= 1)
        ),
      visibleWorktreeItems: worktrees.visible as PaletteItem[],
      worktreeOverflowCount: worktrees.overflowCount,
      visibleProjectTargetItems: projectTargets.visible as PaletteItem[],
      projectTargetOverflowCount: projectTargets.overflowCount,
      visibleMiddleItems: middle.visible as PaletteItem[],
      middleOverflowCount: middle.overflowCount,
      visibleOpenTabItems: openTabs.visible as PaletteItem[],
      openTabOverflowCount: openTabs.overflowCount,
      multiPrimaryFirstScreen,
      multiPrimaryLayout,
      visibleExtraSections: extraSections.map(({ source, items }): VisiblePaletteExtraSection => {
        const expanded = expandedSectionCaps[`extra:${source.id}`] ?? 0
        const capped = capPaletteSection(
          items,
          (hasQuery ? PALETTE_SECTION_RENDER_CAP : source.emptyQueryCap) + expanded
        )
        return {
          source,
          visible: capped.visible,
          overflowCount: capped.overflowCount,
          leads:
            hasQuery &&
            shouldExtraSectionLeadPaletteSections({
              bestEntityQualityRank: bestWorkspaceOrTabQualityRank,
              bestExtraQualityRank: bestPaletteQualityRank(
                items.map((item) => item.result.qualityClass)
              ),
              leadsOnTie: source.leadsOnTie
            })
        }
      })
    }
  }, [
    bestWorkspaceOrTabQualityRank,
    expandedSectionCaps,
    extraSections,
    hasQuery,
    middleItems,
    openTabItems,
    openTabsLeadSections,
    openTabsCap,
    projectTargetItems,
    recentTabItems,
    retainedOpenTabId,
    retainedWorktreeId,
    typedWorktreeCap,
    worktreeItems
  ])

  // Number only snapshotted recent rows: typed queries and expanded rows cannot advertise unavailable numeric shortcuts.
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
