import { useCallback, useMemo } from 'react'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { bestCmdJPaletteSectionQualityClass } from '@/components/cmd-j/palette-results'
import {
  bestPaletteQualityRank,
  NO_PALETTE_QUALITY_RANK,
  shouldIntentSectionLeadPaletteSections,
  shouldOpenTabsLeadPaletteSections
} from '@/lib/cmd-j-section-leadership'
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

type WorktreeJumpPaletteSectionsInput = WorktreeJumpPaletteOpenTabs &
  WorktreeJumpPaletteRecentTabs &
  WorktreeJumpPaletteProjectTargets &
  Pick<WorktreeJumpPaletteQuickActions, 'middleItems'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> &
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

  const middleLeadsSections = useMemo(() => {
    if (!hasQuery) {
      return false
    }
    const bestEntityQualityRank = Math.min(
      worktreeItems.length
        ? bestPaletteQualityRank(worktreeItems.map((item) => item.match.qualityClass))
        : NO_PALETTE_QUALITY_RANK,
      openTabItems.length
        ? bestPaletteQualityRank(openTabItems.map((item) => item.result.qualityClass))
        : NO_PALETTE_QUALITY_RANK
    )
    return shouldIntentSectionLeadPaletteSections({
      bestEntityQualityRank,
      bestIntentQualityRank: bestPaletteQualityRank([
        bestCmdJPaletteSectionQualityClass(middleItems.map((item) => item.result)),
        bestCmdJPaletteSectionQualityClass(projectTargetItems.map((item) => item.result))
      ])
    })
  }, [hasQuery, middleItems, openTabItems, projectTargetItems, worktreeItems])

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
    // Why: "See more" drops the above-the-fold trim outright instead of stepping 20 at a time, so one
    // click reveals the whole recent history the shared render cap allows.
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
    retainedOpenTabId,
    retainedWorktreeId,
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
