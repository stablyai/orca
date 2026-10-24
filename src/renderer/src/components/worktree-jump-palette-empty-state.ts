import { translate } from '@/i18n/i18n'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export function getWorktreeJumpPaletteResultCount(
  controller: WorktreeJumpPaletteController
): number {
  return controller.hasQuery
    ? (controller.viewCounts?.[controller.view] ?? 0)
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
  if (controller.view !== 'all') {
    return getFocusedViewEmptyState(controller)
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

function getFocusedViewEmptyState(controller: WorktreeJumpPaletteController): {
  title: string
  subtitle: string
} {
  if (controller.hasQuery) {
    return {
      title:
        controller.view === 'worktrees'
          ? translate('worktreeJumpPalette.view.noWorktreeMatches', 'No workspaces match')
          : controller.view === 'tabs'
            ? translate('worktreeJumpPalette.view.noTabMatches', 'No tabs match')
            : translate('worktreeJumpPalette.view.noActionMatches', 'No actions or settings match'),
      subtitle: translate(
        'worktreeJumpPalette.view.noMatchesAnywhere',
        'Nothing in other views matches either. Try a different search.'
      )
    }
  }
  return {
    title:
      controller.view === 'worktrees'
        ? translate('worktreeJumpPalette.view.noWorktrees', 'No other workspaces to switch to')
        : controller.view === 'tabs'
          ? translate('worktreeJumpPalette.view.noTabs', 'No open tabs')
          : translate('worktreeJumpPalette.view.noActions', 'No actions available'),
    subtitle: translate('worktreeJumpPalette.view.emptySwitch', 'Press Tab to switch views.')
  }
}
