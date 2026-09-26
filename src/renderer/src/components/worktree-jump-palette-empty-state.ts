import { translate } from '@/i18n/i18n'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export function getWorktreeJumpPaletteResultCount(
  controller: WorktreeJumpPaletteController
): number {
  return controller.hasQuery
    ? controller.worktreeItems.length +
        controller.projectTargetItems.length +
        controller.middleItems.length +
        controller.openTabItems.length
    : controller.selectableItems.length
}

export function getWorktreeJumpPaletteEmptyState(controller: WorktreeJumpPaletteController): {
  title: string
  subtitle: string
} {
  if (controller.filterActive) {
    return {
      title: translate(
        'worktreeJumpPalette.filter.emptyTitle',
        'No results match the active filter'
      ),
      subtitle: translate(
        'worktreeJumpPalette.filter.emptySubtitle',
        'Clear the filter above, or widen it to more hosts and projects.'
      )
    }
  }
  if (
    (controller.hasAnySearchableWorktrees ||
      controller.hasAnyProjectSearchCandidates ||
      controller.hasAnyMiddleResults ||
      controller.hasAnyOpenTabs) &&
    controller.hasQuery
  ) {
    return {
      title: translate(
        'auto.components.WorktreeJumpPalette.dbd9d87eec',
        'No results match your search'
      ),
      subtitle: translate(
        'auto.components.WorktreeJumpPalette.c4afa68159',
        'Try a worktree, project, setting, action, tab title, agent prompt, URL, PR, or port.'
      )
    }
  }
  if (!controller.hasQuery && controller.hasAnyWorktrees && !controller.hasAnyOpenTabs) {
    return {
      title: translate(
        'auto.components.WorktreeJumpPalette.f60f8730be',
        'No other worktrees to switch to'
      ),
      subtitle: translate(
        'auto.components.WorktreeJumpPalette.b781ae05e3',
        'Type to search worktrees, settings, tabs, and actions.'
      )
    }
  }
  return {
    title: translate(
      'auto.components.WorktreeJumpPalette.1628fd7dfa',
      'No active worktrees, settings, actions, or open tabs'
    ),
    subtitle: translate(
      'auto.components.WorktreeJumpPalette.f7fda8d562',
      'Create a worktree or open a tab in Orca to get started.'
    )
  }
}
