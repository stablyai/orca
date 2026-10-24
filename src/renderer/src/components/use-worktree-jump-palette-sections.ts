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
import { cmdJPaletteViewShows, type CmdJPaletteViewSection } from '@/components/cmd-j/palette-view'
import {
  buildCmdJPaletteAlternateViewHint,
  buildCmdJPaletteViewCounts,
  cmdJPaletteMiddleItemSection,
  pickCmdJPaletteAlternateView
} from '@/components/cmd-j/palette-view-counts'
import {
  DIGIT_INDEX_ACTION_ID,
  DIGIT_INDEX_ADDRESSABLE_ROWS,
  EMPTY_QUERY_RECENT_TAB_CAP,
  EMPTY_QUERY_ROW_BUDGET,
  EMPTY_QUERY_WORKTREE_CAP,
  FOCUSED_VIEW_EMPTY_QUERY_CAP,
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
import type { WorktreeJumpPaletteTaskSearch } from './use-worktree-jump-palette-task-search'

type WorktreeJumpPaletteSectionsInput = WorktreeJumpPaletteOpenTabs &
  WorktreeJumpPaletteRecentTabs &
  WorktreeJumpPaletteProjectTargets &
  Pick<WorktreeJumpPaletteQuickActions, 'middleItems'> &
  Pick<WorktreeJumpPaletteWorktrees, 'hasQuery'> &
  Pick<WorktreeJumpPaletteTaskSearch, 'taskItems'> &
  Pick<
    WorktreeJumpPaletteLocalState,
    | 'createWorktreeName'
    | 'showCreateAction'
    | 'expandedSectionCaps'
    | 'setExpandedSectionCaps'
    | 'selectedItemId'
    | 'view'
    | 'setView'
  >

export function useWorktreeJumpPaletteSections({
  hasQuery,
  worktreeItems: allWorktreeItems,
  openTabItems: allOpenTabItems,
  recentTabItems: allRecentTabItems,
  projectTargetItems: allProjectTargetItems,
  middleItems: allMiddleItems,
  createWorktreeName,
  showCreateAction: createActionAvailable,
  expandedSectionCaps,
  setExpandedSectionCaps,
  selectedItemId,
  view,
  setView,
  taskItems
}: WorktreeJumpPaletteSectionsInput) {
  const viewCounts = useMemo(
    () =>
      hasQuery
        ? buildCmdJPaletteViewCounts({
            worktrees: allWorktreeItems.length,
            projects: allProjectTargetItems.length,
            openTabs: allOpenTabItems.length,
            tasks: taskItems.length,
            middleItems: allMiddleItems
          })
        : null,
    [
      allMiddleItems,
      allOpenTabItems.length,
      allProjectTargetItems.length,
      allWorktreeItems.length,
      hasQuery,
      taskItems.length
    ]
  )
  const alternateView = useMemo(
    () => pickCmdJPaletteAlternateView(view, viewCounts),
    [view, viewCounts]
  )
  // Why first in the list: Enter on it switches views, so a query matching only elsewhere is never a dead end.
  const alternateViewHint = useMemo(
    () =>
      alternateView && viewCounts
        ? buildCmdJPaletteAlternateViewHint(alternateView, viewCounts, setView)
        : null,
    [alternateView, setView, viewCounts]
  )
  const viewScope = useMemo(() => {
    const shows = (section: CmdJPaletteViewSection): boolean => cmdJPaletteViewShows(view, section)
    return {
      worktreeItems: shows('worktrees') ? allWorktreeItems : [],
      openTabItems: shows('open-tabs') ? allOpenTabItems : [],
      recentTabItems: shows('open-tabs') ? allRecentTabItems : [],
      projectTargetItems: shows('projects') ? allProjectTargetItems : [],
      middleItems: allMiddleItems.filter((item) => shows(cmdJPaletteMiddleItemSection(item)))
    }
  }, [
    allMiddleItems,
    allOpenTabItems,
    allProjectTargetItems,
    allRecentTabItems,
    allWorktreeItems,
    view
  ])
  const { worktreeItems, openTabItems, recentTabItems, projectTargetItems, middleItems } = viewScope
  const showCreateAction = createActionAvailable && cmdJPaletteViewShows(view, 'create-worktree')
  // Why: a single-kind view has the whole list to itself, so it drops the mixed-list row budget.
  const focusedView = view !== 'all'
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
    const recentTabsCap = focusedView
      ? FOCUSED_VIEW_EMPTY_QUERY_CAP + (expandedSectionCaps['open-tabs'] ?? 0)
      : expandedSectionCaps['open-tabs']
        ? openTabsCap
        : EMPTY_QUERY_RECENT_TAB_CAP
    const openTabs = hasQuery
      ? capPaletteSection(openTabItems, openTabsCap, retainOpenTab)
      : capPaletteSection(recentTabItems, recentTabsCap)
    const baseWorktreeCap = hasQuery
      ? Infinity
      : focusedView
        ? FOCUSED_VIEW_EMPTY_QUERY_CAP
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
      hasQuery || focusedView ? middleItems : [],
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
    focusedView,
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

  // Why: badges number the snapshotted empty-query rows only — ⌘N is meaningless on a typed query, and
  // an expanded section leaves its unaddressable rows unbadged rather than advertising ⌘10.
  const digitShortcutItems = useMemo<readonly PaletteItem[]>(() => {
    if (hasQuery) {
      return []
    }
    const rows =
      view === 'worktrees'
        ? paletteSections.visibleWorktreeItems
        : paletteSections.visibleOpenTabItems
    return rows.slice(0, DIGIT_INDEX_ADDRESSABLE_ROWS)
  }, [hasQuery, paletteSections, view])
  const rowShortcutIndexByItem = useMemo(
    () => new Map(digitShortcutItems.map((item, index) => [item, index])),
    [digitShortcutItems]
  )
  const digitShortcutModifiers =
    useShortcutKeyComboDetails(DIGIT_INDEX_ACTION_ID)[0]?.keys.slice(0, -1) ?? []

  return {
    viewCounts,
    alternateView,
    alternateViewHint,
    openTabsLeadSections,
    middleLeadsSections,
    paletteSections,
    digitShortcutItems,
    rowShortcutIndexByItem,
    digitShortcutModifiers,
    createWorktreeName,
    showCreateAction,
    handleExpandSection
  }
}

export type WorktreeJumpPaletteSections = ReturnType<typeof useWorktreeJumpPaletteSections>
